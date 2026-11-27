-- Referrals: a friend who joined with a customer's code (Admin -> Growth -> Referral rewards). One row per friend.
CREATE TABLE IF NOT EXISTS referrals (
  id CHAR(36) NOT NULL PRIMARY KEY,
  referrer_id CHAR(36) NOT NULL,
  referee_id CHAR(36) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'joined',
  reward_paise INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  rewarded_at DATETIME(6) NULL,
  UNIQUE KEY uq_referrals_referee_id (referee_id),
  KEY ix_referrals_referrer_id (referrer_id),
  CONSTRAINT fk_referrals_referrer_id_users FOREIGN KEY (referrer_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_referrals_referee_id_users FOREIGN KEY (referee_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_referrals_status CHECK (status IN ('joined','rewarded','capped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
