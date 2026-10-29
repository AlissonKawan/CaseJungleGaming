import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntry } from '../../domain/ledger/ledger-entry';
import { IntegrationEventType } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-inbox';
import { Money } from '../../domain/money/money';
import {
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionKind,
  computeCanonicalPayloadHash,
} from '../../domain/transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { DuplicateWalletError } from '../errors/application-errors';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../ports/wagering-unit-of-work.port';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance?: string;
  idempotencyKey?: string;
}

export interface WalletView {
  walletId: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  idempotentReplay: boolean;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort
  ) {}

  public async execute(command: CreateWalletCommand): Promise<WalletView> {
    const playerId = command.playerId?.trim();
    const currency = (command.currency ?? 'BRL').trim().toUpperCase();
    const initialAmountStr = command.initialBalance ?? '0.00';
    const initialMoney = Money.from(initialAmountStr, currency);
    const idempotencyKey =
      command.idempotencyKey?.trim() || `wallet-open:${playerId}:${currency}`;

    const payloadHash = computeCanonicalPayloadHash({
      providerId: 'INTERNAL_SYSTEM',
      externalTransactionId: `OPENING:${playerId}:${currency}`,
      playerId,
      walletId: `WALLET:${playerId}:${currency}`,
      roundId: 'OPENING_ROUND',
      gameId: 'WALLET_OPENING',
      kind: WagerTransactionKind.Opening,
      money: initialMoney.toJSON(),
    });

    return this.uow.runInTransaction(async (repos) => {
      const existingTx = await repos.findTransactionByIdempotencyKey(idempotencyKey);
      if (existingTx) {
        if (existingTx.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError(idempotencyKey);
        }
        if (existingTx.responseSnapshot) {
          return {
            ...(existingTx.responseSnapshot as unknown as WalletView),
            idempotentReplay: true,
          };
        }
      }

      const existingWallet = await repos.findWalletByPlayerAndCurrency(playerId, currency);
      if (existingWallet) {
        if (existingWallet.balance.equals(initialMoney) && command.idempotencyKey) {
          return {
            walletId: existingWallet.id,
            playerId: existingWallet.playerId,
            currency: existingWallet.currency,
            balance: existingWallet.balance.amount,
            version: existingWallet.version,
            createdAt: existingWallet.createdAt.toISOString(),
            updatedAt: existingWallet.updatedAt.toISOString(),
            idempotentReplay: true,
          };
        }
        throw new DuplicateWalletError(playerId, currency);
      }

      const now = new Date();
      const wallet = Wallet.create({
        playerId,
        currency,
        initialBalance: initialMoney,
      });

      await repos.insertWallet(wallet);

      const snapshot: WalletView = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.amount,
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
        idempotentReplay: false,
      };

      if (initialMoney.isPositive()) {
        const openingTx = WagerTransaction.create({
          providerId: 'INTERNAL_SYSTEM',
          externalTransactionId: `OPENING:${wallet.id}`,
          idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'OPENING_ROUND',
          gameId: 'WALLET_OPENING',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
          allowOpening: true,
        });

        openingTx.markProcessed(undefined, now, snapshot as unknown as Record<string, unknown>);
        await repos.insertTransaction(openingTx);

        const zeroMoney = Money.zero(currency);
        const ledgerEntry = LedgerEntry.create({
          walletId: wallet.id,
          transactionId: openingTx.id,
          direction: 'CREDIT',
          operationType: 'OPENING',
          amount: initialMoney,
          balanceBefore: zeroMoney,
          balanceAfter: initialMoney,
          createdAt: now,
        });
        await repos.insertLedgerEntry(ledgerEntry);

        const outboxMsg = OutboxMessage.create({
          aggregateType: 'Wallet',
          aggregateId: wallet.id,
          eventType: IntegrationEventType.WalletBalanceChanged,
          payload: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            transactionId: openingTx.id,
            ledgerEntryId: ledgerEntry.id,
            direction: 'CREDIT',
            operationType: 'OPENING',
            amount: initialMoney.amount,
            currency: initialMoney.currency,
            balanceBefore: zeroMoney.amount,
            balanceAfter: initialMoney.amount,
            walletVersion: wallet.version,
            occurredAt: now.toISOString(),
          },
          createdAt: now,
        });
        await repos.insertOutboxMessage(outboxMsg);
      }

      return snapshot;
    });
  }
}
