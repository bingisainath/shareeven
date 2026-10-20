"""app_settings.value can hold longer values (the Pro plan's prices and features, as JSON)

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-20 02:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = '0026'
down_revision = '0025'
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column('app_settings', 'value', type_=sa.Text(), existing_type=sa.String(500), existing_nullable=False)


def downgrade():
    op.alter_column('app_settings', 'value', type_=sa.String(500), existing_type=sa.Text(), existing_nullable=False)
