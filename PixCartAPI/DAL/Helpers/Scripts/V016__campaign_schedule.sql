-- Campaigns can be scheduled for later.
ALTER TABLE segment_campaigns ADD COLUMN status VARCHAR(10) NOT NULL DEFAULT 'sent';
ALTER TABLE segment_campaigns ADD COLUMN send_at DATETIME(6) NULL;
