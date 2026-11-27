"""Assistant actions get a 'running' status so a double confirm cannot run one twice."""
from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None

OLD = "status IN ('pending','done','cancelled','failed','expired')"
NEW = "status IN ('pending','running','done','cancelled','failed','expired')"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_assistant_actions_status"), "assistant_actions", type_="check")
    op.create_check_constraint(op.f("ck_assistant_actions_status"), "assistant_actions", NEW)


def downgrade() -> None:
    op.execute("UPDATE assistant_actions SET status='failed' WHERE status='running'")
    op.drop_constraint(op.f("ck_assistant_actions_status"), "assistant_actions", type_="check")
    op.create_check_constraint(op.f("ck_assistant_actions_status"), "assistant_actions", OLD)
