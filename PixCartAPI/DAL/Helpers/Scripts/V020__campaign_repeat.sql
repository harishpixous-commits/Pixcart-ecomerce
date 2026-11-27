-- Scheduled campaigns can repeat: repeat_days (0 = once) and how many further sends are left after this one.
ALTER TABLE segment_campaigns ADD COLUMN repeat_days INT NOT NULL DEFAULT 0, ADD COLUMN repeats_left INT NOT NULL DEFAULT 0;
