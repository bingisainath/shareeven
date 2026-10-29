"""Support requests people send to the ShareEven team, and the team's answers

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-28 12:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '0028'
down_revision = '0027'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'support_tickets',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('category', sa.String(20), nullable=False),
        sa.Column('subject', sa.String(120), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('app_info', sa.String(100), nullable=True),
        sa.Column('status', sa.String(10), nullable=False, server_default='open'),
        sa.Column('reply', sa.Text(), nullable=True),
        sa.Column('replied_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('replied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_support_tickets_user_id', 'support_tickets', ['user_id'])
    op.create_index('ix_support_tickets_status', 'support_tickets', ['status'])


def downgrade():
    op.drop_index('ix_support_tickets_status', table_name='support_tickets')
    op.drop_index('ix_support_tickets_user_id', table_name='support_tickets')
    op.drop_table('support_tickets')
