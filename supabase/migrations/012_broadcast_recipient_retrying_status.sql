ALTER TABLE broadcast_recipients
  DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;

ALTER TABLE broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending', 'retrying', 'sent', 'delivered', 'read', 'replied', 'failed'));
