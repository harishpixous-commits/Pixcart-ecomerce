-- A size guide table per category, shown on product pages.
ALTER TABLE categories ADD COLUMN size_guide TEXT NOT NULL DEFAULT (''); 
