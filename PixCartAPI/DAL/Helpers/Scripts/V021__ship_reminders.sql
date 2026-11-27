-- Ship reminders: remember which package the seller was already reminded about.
ALTER TABLE sub_orders ADD COLUMN ship_reminded_at DATETIME(6) NULL;
