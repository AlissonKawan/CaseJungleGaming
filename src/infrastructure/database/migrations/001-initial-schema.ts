export const INITIAL_SCHEMA_UP_SQL = `
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY,
  player_id VARCHAR(128) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(20, 2) NOT NULL CHECK (balance >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

CREATE TABLE IF NOT EXISTS wager_transactions (
  id UUID PRIMARY KEY,
  provider_id VARCHAR(128) NOT NULL,
  external_transaction_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  player_id VARCHAR(128) NOT NULL,
  round_id VARCHAR(128) NOT NULL,
  game_id VARCHAR(128) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  amount NUMERIC(20, 2) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(32) NOT NULL,
  failure_code VARCHAR(64) NULL,
  reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
  reference_external_transaction_id VARCHAR(128) NULL,
  response_snapshot JSONB NULL,
  processed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet_id ON wager_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wager_tx_status_created ON wager_transactions(status, created_at);

-- Garante no banco que cada transacao referenciada so pode ter no maximo 1 reversao PROCESSED (REFUND ou ROLLBACK)
CREATE UNIQUE INDEX IF NOT EXISTS uq_wager_tx_single_processed_reversal
  ON wager_transactions(reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
  operation_type VARCHAR(32) NOT NULL CHECK (operation_type IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')),
  amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL,
  balance_before NUMERIC(20, 2) NOT NULL CHECK (balance_before >= 0),
  balance_after NUMERIC(20, 2) NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ledger_tx_id UNIQUE (transaction_id),
  CONSTRAINT chk_ledger_math CHECK (
    (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
    (direction = 'DEBIT' AND balance_before - amount = balance_after)
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created ON wallet_ledger_entries(wallet_id, created_at, id);

-- Trigger append-only: proibe UPDATE e DELETE em wallet_ledger_entries
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is strictly append-only: % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_mutation ON wallet_ledger_entries;
CREATE TRIGGER trg_prevent_ledger_mutation
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TABLE IF NOT EXISTS inbox_messages (
  id UUID PRIMARY KEY,
  consumer_name VARCHAR(128) NOT NULL,
  message_id VARCHAR(255) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id)
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id UUID PRIMARY KEY,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  last_error TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages(status, next_attempt_at, created_at);
`;

export const INITIAL_SCHEMA_DOWN_SQL = `
DROP TRIGGER IF EXISTS trg_prevent_ledger_mutation ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS prevent_ledger_mutation();
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
`;
