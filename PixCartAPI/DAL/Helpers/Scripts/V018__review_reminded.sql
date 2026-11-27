-- Review reminders: remember which delivered package was already reminded.
ALTER TABLE sub_orders ADD COLUMN review_reminded_at DATETIME(6) NULL;
