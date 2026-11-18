"""Assistant capability permissions on the starting roles

Adds assistant_actions / assistant_files / assistant_voice to roles that existed before these permissions,
matching app.core.permissions.DEFAULT_ROLES. Roles edited by admins keep their own choices otherwise.

Revision ID: 0005
Revises: 0004
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_ADD = {
    "owner": ["assistant_actions", "assistant_files", "assistant_voice", "ai_providers"],
    "operations": ["assistant_actions", "assistant_files", "assistant_voice"],
    "finance": ["assistant_files", "assistant_voice"],
}


def upgrade() -> None:
    for code, perms in _ADD.items():
        for p in perms:
            op.execute(
                f"UPDATE admin_roles SET permissions = permissions || '[\"{p}\"]'::jsonb "
                f"WHERE code = '{code}' AND NOT permissions ? '{p}'"
            )


def downgrade() -> None:
    for code, perms in _ADD.items():
        for p in perms:
            op.execute(f"UPDATE admin_roles SET permissions = permissions - '{p}' WHERE code = '{code}'")
