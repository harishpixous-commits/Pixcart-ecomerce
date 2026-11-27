-- In-app messages staff send to a customer segment, kept as a log.
CREATE TABLE IF NOT EXISTS segment_campaigns (
  id CHAR(36) NOT NULL PRIMARY KEY,
  segment VARCHAR(20) NOT NULL,
  title VARCHAR(80) NOT NULL,
  message VARCHAR(300) NOT NULL,
  link VARCHAR(200) NOT NULL DEFAULT '',
  recipients INT NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL,
  KEY ix_segment_campaigns_created_at (created_at),
  CONSTRAINT fk_segment_campaigns_created_by_users FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
