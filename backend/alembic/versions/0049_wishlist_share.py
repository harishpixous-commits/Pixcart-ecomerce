"""A private link a shopper can share to show their wishlist."""
import sqlalchemy as sa
from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("wishlist_share_token", sa.String(32), nullable=True))
    op.create_index("ix_users_wishlist_share_token", "users", ["wishlist_share_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_wishlist_share_token", table_name="users")
    op.drop_column("users", "wishlist_share_token")
