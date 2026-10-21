"""ShareEven Pro payments: one row per Razorpay order, and how long each person has Pro

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-20 12:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '0027'
down_revision = '0026'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'payments',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('provider', sa.String(20), nullable=False),
        sa.Column('order_id', sa.String(64), nullable=False, unique=True),
        sa.Column('payment_id', sa.String(64), nullable=True, unique=True),
        sa.Column('billing', sa.String(10), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('amount_minor', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='created'),
        sa.Column('error', sa.String(300), nullable=True),
        sa.Column('pro_from', sa.DateTime(timezone=True), nullable=True),
        sa.Column('pro_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('refunds', postgresql.JSONB(), nullable=True),
        sa.Column('refunded_minor', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('raw_event', postgresql.JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_payments_user_created', 'payments', ['user_id', 'created_at'])
    op.add_column('users', sa.Column('pro_until', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('pro_reminded_days', sa.Integer(), nullable=True))
    op.create_index('ix_users_pro_until', 'users', ['pro_until'])


def downgrade():
    op.drop_index('ix_users_pro_until', table_name='users')
    op.drop_column('users', 'pro_reminded_days')
    op.drop_column('users', 'pro_until')
    op.drop_index('ix_payments_user_created', table_name='payments')
    op.drop_table('payments')
