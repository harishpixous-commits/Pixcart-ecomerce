-- Campaign products keep the order the seller added them in, like the reference (PostgreSQL returns them in insertion
-- order; MySQL would return them by their random ids). seq records that order; the campaign product lists sort by it.
ALTER TABLE ad_campaign_products ADD COLUMN seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE;
