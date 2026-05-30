ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'stopped'));
