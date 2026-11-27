-- Ticket satisfaction rating: the customer rates a resolved or closed request once.
ALTER TABLE support_tickets ADD COLUMN csat_rating INT NULL, ADD COLUMN csat_comment VARCHAR(500) NOT NULL DEFAULT '', ADD COLUMN csat_at DATETIME(6) NULL, ADD CONSTRAINT ck_support_tickets_csat CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5);
