"""home page: the "Image or video block" section kind (a picture or a video with heading, text and a button)

Revision ID: 0025
Revises: 0024
"""
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

KINDS = "'hero','categories','products','banner','banner_grid','text','usp','recent','cards','deals','sponsored','countdown','signin','inspired','buy_again'"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_home_sections_kind"), "home_sections", type_="check")
    op.create_check_constraint(op.f("ck_home_sections_kind"), "home_sections", f"kind IN ({KINDS},'media')")


def downgrade() -> None:
    op.execute("DELETE FROM home_sections WHERE kind = 'media'")
    op.drop_constraint(op.f("ck_home_sections_kind"), "home_sections", type_="check")
    op.create_check_constraint(op.f("ck_home_sections_kind"), "home_sections", f"kind IN ({KINDS})")
