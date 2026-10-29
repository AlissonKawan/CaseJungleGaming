# Architecture & Technical Decisions — Distributed Wagering Processor

## 1. Architectural Overview

This system implements a distributed, fault-tolerant financial wagering processor using **Clean / Hexagonal Architecture** and **Domain-Driven Design (DDD)** tactical patterns on top of **Bun 1.x**, **TypeScript (strict mode)**, **NestJS**, **PostgreSQL**, and **AWS SQS (LocalStack/MiniStack)**.

The codebase is divided into four explicit layers:
1. **`src/domain` (Pure Domain Core):** Contains `Money`, `Wallet`, `LedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, and `IntegrationEvent`. Zero framework or ORM dependencies.
2. **`src/application` (Use Cases & Ports):** Orchestrates atomic business workflows (`CreateWalletUseCase`, `ProcessWagerTransactionUseCase`, `ReconcileWalletUseCase`, `ResolvePendingReferencesUseCase`). Both HTTP Controllers and SQS Consumers invoke the exact same Use Case.
3. **`src/infrastructure` (Adapters, Persistence & Messaging):** PostgreSQL transactional repositories, migrations, row-level locking (`SELECT ... FOR UPDATE`), Outbox publisher worker, and SQS FIFO consumer.
4. **`src/interfaces` (Entrypoints):** REST Controllers, DTO validation, and Health Check endpoints (`/health/live`, `/health/ready`).

---

## 2. Core Design Decisions & Trade-offs

### 2.1 Monetary Precision (`Money` Value Object)
- **Decision:** All monetary values are encapsulated in the immutable `Money` Value Object backed by `decimal.js`, serialized as fixed 2-decimal strings (`"25.00"`) and stored in PostgreSQL as `NUMERIC(20, 2)` (with `currency` in a separate `VARCHAR(3)` column).
- **Why:** Native IEEE-754 floating-point `number` introduces binary rounding errors (`0.1 + 0.2 = 0.30000000000000004`). `Money.from()` rejects `number` primitives, scientific notation, `NaN`, `Infinity`, and scales greater than 2 decimal places without silent rounding.

### 2.2 Concurrency Control per Wallet (`walletId` Unit of Concurrency)
- **Decision:** Pessimistic row-level locking (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE`) inside a single ACID SQL transaction, combined with a `version` column that increments strictly when the wallet balance changes and a database constraint `CHECK (balance >= 0)`.
- **Why:** In a hot-wallet scenario (e.g., two concurrent `80.00 BRL` bets against a `100.00 BRL` balance across multiple application instances), optimistic locking alone forces high retry churn and contention failures, while in-memory mutexes fail across multiple Node/Bun processes. `SELECT ... FOR UPDATE` serializes concurrent operations strictly per `walletId` at the database level while allowing distinct wallets to process completely in parallel.

### 2.3 Persistent Idempotency & Canonical Payload Hashing
- **Decision:** Every operation requires an `Idempotency-Key` persisted in PostgreSQL with a `UNIQUE` constraint, paired with a deterministic `payloadHash` (SHA-256 over canonical JSON with alphabetically sorted business keys) and a persisted `responseSnapshot`.
- **Why:**
  - **Same `Idempotency-Key` + Same `payloadHash`:** Returns the historical `responseSnapshot` with `idempotentReplay: true` without mutating balance or duplicating ledger entries.
  - **Same `Idempotency-Key` + Different `payloadHash`:** Rejected immediately with HTTP `409 Conflict` (`IdempotencyConflictError`).

### 2.4 Immutable Append-Only Ledger & Reconciliation
- **Decision:** Every balance mutation (`OPENING`, `BET`, `WIN`, `REFUND`, `ROLLBACK`) produces exactly one immutable `LedgerEntry` recording `direction` (`CREDIT` | `DEBIT`), `amount`, `balanceBefore`, and `balanceAfter`. `LOSS` and `REJECTED` transactions do not change balance and never produce a `LedgerEntry`.
- **Database enforcement:** A PostgreSQL trigger/rule prevents `UPDATE` and `DELETE` on `wallet_ledger_entries`.
- **Reconciliation:** `POST /wallets/:walletId/reconciliation` computes `SUM(CREDIT) - SUM(DEBIT)` from the ledger and compares it against `wallet.balance`. Discrepancies are never silently overwritten; they are logged, counted in metrics, and returned explicitly.

### 2.5 Transactional Inbox & Outbox with SQS
- **Decision:** SQS messages are deduplicated via an `inbox_messages` table (`UNIQUE (consumer_name, message_id)`). Domain integration events (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) are persisted in `outbox_messages` within the **same SQL transaction** as the wallet, transaction, and ledger changes.
- **Why:** Prevents dual-write inconsistencies (publishing an event before DB commit or losing an event if the process crashes right after commit). SQS `ack` (`DeleteMessage`) happens strictly after SQL `COMMIT`. Concurrent outbox publishers claim rows using `SELECT ... FOR UPDATE SKIP LOCKED`.

### 2.6 Out-of-Order References (`PENDING_REFERENCE`)
- **Decision:** When a `REFUND` or `ROLLBACK` arrives before its referenced transaction (`referenceExternalTransactionId`), it is persisted as `PENDING_REFERENCE` (emitting `WagerTransactionPendingReference`) and retried with exponential backoff by a scheduled worker until resolved or until the retry TTL expires (transitioning to `REJECTED` with `FailureCode.ReferenceNotFound`).

### 2.7 Authentication Scope (Section 2)
- **Decision:** Per Section 2 of the challenge specification, authentication is not scored and should not compete with financial correctness, concurrency, and idempotency. We expose an explicit extension point (`ProviderIdentityGuard` / `ProviderIdentityPort`) configured as a no-op guard by default, designed to validate OIDC/JWT bearer tokens issued by an external Identity Provider (such as **Keycloak** or **Zitadel**) while keeping `/health/live` and `/health/ready` public.
