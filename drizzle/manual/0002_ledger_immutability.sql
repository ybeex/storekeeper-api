-- PRD §24 / §50: historical transactions are never rewritten. Enforced in the
-- database so that no application bug, ad-hoc script, or compromised
-- credential with ordinary DML rights can silently edit the ledger.
CREATE OR REPLACE FUNCTION storekeeper_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transactions is append-only (% blocked); write a corrective transaction instead', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_no_update ON transactions;
CREATE TRIGGER transactions_no_update BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION storekeeper_ledger_immutable();
DROP TRIGGER IF EXISTS transactions_no_truncate ON transactions;
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION storekeeper_ledger_immutable();

-- Same guarantee for the audit trail.
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION storekeeper_ledger_immutable();

-- Self-referencing ledger links (kept out of Drizzle to avoid circular type inference).
ALTER TABLE transactions
  ADD CONSTRAINT transactions_corrects_fk FOREIGN KEY (corrects_transaction_id) REFERENCES transactions(id),
  ADD CONSTRAINT transactions_related_fk FOREIGN KEY (related_transaction_id) REFERENCES transactions(id);
ALTER TABLE locations
  ADD CONSTRAINT locations_parent_fk FOREIGN KEY (parent_id) REFERENCES locations(id);

-- PRD §50: a transaction can be corrected at most once. The unique index makes the
-- "already corrected?" check race-free instead of relying on a read-then-write.
CREATE UNIQUE INDEX IF NOT EXISTS tx_corrects_unique
  ON transactions (corrects_transaction_id) WHERE corrects_transaction_id IS NOT NULL;
