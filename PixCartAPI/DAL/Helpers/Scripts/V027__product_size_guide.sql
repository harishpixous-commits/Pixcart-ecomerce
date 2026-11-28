-- A product can carry its own size guide, ahead of its category's.
ALTER TABLE products ADD COLUMN size_guide TEXT NOT NULL DEFAULT ('');
