import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../../application/ports/wagering-unit-of-work.port';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import {
  InboxMessage,
  InboxMessageStatus,
  type OutboxMessage,
} from '../../domain/messaging/outbox-inbox';
import {
  IdempotencyConflictError,
  computeCanonicalPayloadHash,
} from '../../domain/transaction/wager-transaction';

/**
 * Servico de Mensageria AWS SQS (LocalStack / MiniStack) + Transactional Inbox + Outbox Publisher.
 *
 * Por que existe o LocalStack ('AWS Fake')?
 * Em producao, a Jungle Gaming usa o AWS SQS (Simple Queue Service - servico de filas da Amazon).
 * Para voce rodar na sua maquina sem precisar de conta paga na AWS nem cartao de credito,
 * o LocalStack roda dentro do Docker simulando a API identica da AWS na porta 4566!
 */
@Injectable()
export class SqsWageringMessagingService {
  private readonly sqsClient: SQSClient;
  private readonly consumerName = 'wager-transactions-sqs-consumer';
  private readonly publishedInMemoryEvents: OutboxMessage[] = [];

  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase
  ) {
    this.sqsClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  /**
   * Verifica se o LocalStack / SQS esta acessivel (usado no /health/ready).
   */
  public async pingQueue(): Promise<boolean> {
    if (process.env.SQS_ENABLED === 'false') {
      return true;
    }
    try {
      const queueName = process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo';
      await this.sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Processa uma mensagem recebida da fila SQS aplicando o padrao Transactional Inbox
   * e chamando exatamente o mesmo Use Case da API HTTP.
   */
  public async handleIncomingQueueMessage(
    messageId: string,
    command: ProcessWagerTransactionCommand
  ): Promise<{ deduplicated: boolean }> {
    const payloadHash = computeCanonicalPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    // 1. Verifica na tabela inbox_messages se este messageId ja foi processado
    const existingInbox = await this.uow.runInTransaction(async (repos) => {
      return repos.findInboxMessage(this.consumerName, messageId);
    });

    if (existingInbox) {
      if (existingInbox.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError(`inbox:${this.consumerName}:${messageId}`);
      }
      return { deduplicated: true };
    }

    // 2. Executa o mesmo caso de uso financeiro (idempotente por idempotencyKey)
    await this.processWagerUseCase.execute(command);

    // 3. Registra o messageId no Inbox apos conclusao
    await this.uow.runInTransaction(async (repos) => {
      const alreadyRecorded = await repos.findInboxMessage(this.consumerName, messageId);
      if (!alreadyRecorded) {
        await repos.insertInboxMessage(
          InboxMessage.create({
            consumerName: this.consumerName,
            messageId,
            payloadHash,
            status: InboxMessageStatus.Processed,
          })
        );
      }
    });

    return { deduplicated: false };
  }

  /**
   * Worker de Outbox: reclama um lote de mensagens PENDING usando FOR UPDATE SKIP LOCKED,
   * publica no SQS (ou sink configuravel em testes) e marca como PUBLISHED.
   */
  public async publishPendingOutboxBatch(
    limit: number = 25,
    customPublisher?: (msg: OutboxMessage) => Promise<void>
  ): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;

    await this.uow.runInTransaction(async (repos) => {
      const pendingMessages = await repos.claimPendingOutboxMessages(limit);

      for (const msg of pendingMessages) {
        try {
          if (customPublisher) {
            await customPublisher(msg);
          } else if (process.env.SQS_EVENTS_QUEUE_URL) {
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: process.env.SQS_EVENTS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  eventId: msg.id,
                  eventType: msg.eventType,
                  aggregateType: msg.aggregateType,
                  aggregateId: msg.aggregateId,
                  payload: msg.payload,
                  createdAt: msg.createdAt.toISOString(),
                }),
                MessageGroupId: msg.aggregateId,
                MessageDeduplicationId: msg.id,
              })
            );
          } else {
            this.publishedInMemoryEvents.push(msg);
          }
          msg.markPublished();
          await repos.updateOutboxMessage(msg);
          published += 1;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          msg.recordAttemptFailure(errMsg);
          await repos.updateOutboxMessage(msg);
          failed += 1;
        }
      }
    });

    return { published, failed };
  }

  /**
   * Faz polling de 1 lote da fila SQS wager-transactions.fifo e so envia o ACK (DeleteMessage)
   * APOS o commit no banco de dados!
   */
  public async pollSqsOnce(queueUrl: string): Promise<number> {
    const response = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      })
    );

    const messages = response.Messages ?? [];
    let processedCount = 0;

    for (const msg of messages) {
      if (!msg.Body || !msg.MessageId || !msg.ReceiptHandle) {
        continue;
      }
      const parsed = JSON.parse(msg.Body) as ProcessWagerTransactionCommand;
      await this.handleIncomingQueueMessage(msg.MessageId, parsed);

      // ACK (DeleteMessage) estritamente APOS o commit da transacao no banco!
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        })
      );
      processedCount += 1;
    }

    return processedCount;
  }

  public getPublishedInMemoryEvents(): ReadonlyArray<OutboxMessage> {
    return this.publishedInMemoryEvents;
  }
}
