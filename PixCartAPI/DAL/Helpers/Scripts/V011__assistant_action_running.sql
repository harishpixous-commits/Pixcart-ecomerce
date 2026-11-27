-- Assistant actions get a 'running' status so a double confirm cannot run one twice.
ALTER TABLE assistant_actions DROP CHECK ck_assistant_actions_status;
ALTER TABLE assistant_actions ADD CONSTRAINT ck_assistant_actions_status CHECK (status IN ('pending','running','done','cancelled','failed','expired'));
