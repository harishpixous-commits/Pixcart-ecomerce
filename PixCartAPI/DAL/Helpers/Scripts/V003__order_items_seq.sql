-- Order lines keep the order they were placed in (the cart's order), like the reference: PostgreSQL returns them in
-- insertion order, while MySQL would return them by their random ids. seq records that order; item lists sort by it.
ALTER TABLE order_items ADD COLUMN seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE;
