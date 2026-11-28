-- Photos a customer attaches to a return request (a JSON list of image addresses).
ALTER TABLE return_requests ADD COLUMN photos JSON NOT NULL DEFAULT (JSON_ARRAY());
