-- users.staff_note and users.staff_tags: private staff notes and labels on a customer
ALTER TABLE users ADD COLUMN staff_note TEXT NOT NULL DEFAULT (''), ADD COLUMN staff_tags JSON NOT NULL DEFAULT (JSON_ARRAY());
