-- AI agents: proposals waiting for owner approval. One per idea (dedupe_key), never re-proposed after a rejection.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id CHAR(36) NOT NULL PRIMARY KEY,
  agent VARCHAR(30) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  dedupe_key VARCHAR(120) NOT NULL,
  summary VARCHAR(500) NOT NULL,
  details JSON NOT NULL,
  params JSON NOT NULL,
  permission VARCHAR(30) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  result JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  decided_at DATETIME(6) NULL,
  decided_by CHAR(36) NULL,
  UNIQUE KEY uq_agent_proposals_dedupe_key (dedupe_key),
  KEY ix_agent_proposals_agent (agent),
  KEY ix_agent_proposals_status (status),
  CONSTRAINT ck_agent_proposals_status CHECK (status IN ('pending','running','done','rejected','expired','failed')),
  CONSTRAINT fk_agent_proposals_decided_by_users FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
