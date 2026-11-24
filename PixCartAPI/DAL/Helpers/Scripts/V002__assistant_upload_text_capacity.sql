-- Assistant text uploads preserve the source's 200,000-character limit, including utf8mb4.
ALTER TABLE assistant_uploads MODIFY COLUMN text MEDIUMTEXT NOT NULL;
