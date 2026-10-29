import { Inject, Injectable } from '@nestjs/common';
import { EntityNotFoundError } from '../errors/application-errors';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../ports/wagering-unit-of-work.port';

export interface WalletReconciliationResult {
  walletId: string;
  playerId: string;
  currency: string;
  walletBalance: string;
  ledgerDerivedBalance: string;
  totalCredits: string;
  totalDebits: string;
  discrepancyAmount: string;
  entryCount: number;
  status: 'CONSISTENT' | 'INCONSISTENT';
  checkedAt: string;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort
  ) {}

  public async execute(walletId: string): Promise<WalletReconciliationResult> {
    return this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletById(walletId);
      if (!wallet) {
        throw new EntityNotFoundError('Wallet', walletId);
      }

      const totals = await repos.computeLedgerTotals(wallet.id, wallet.currency);
      const ledgerDerived = totals.totalCredits.minus(totals.totalDebits);
      const isConsistent = wallet.balance.equals(ledgerDerived);

      // Calculo seguro da diferenca absoluta usando Money
      const discrepancy = wallet.balance.isGreaterThanOrEqual(ledgerDerived)
        ? wallet.balance.minus(ledgerDerived)
        : ledgerDerived.minus(wallet.balance);

      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        walletBalance: wallet.balance.amount,
        ledgerDerivedBalance: ledgerDerived.amount,
        totalCredits: totals.totalCredits.amount,
        totalDebits: totals.totalDebits.amount,
        discrepancyAmount: discrepancy.amount,
        entryCount: totals.entryCount,
        status: isConsistent ? 'CONSISTENT' : 'INCONSISTENT',
        checkedAt: new Date().toISOString(),
      };
    });
  }
}
