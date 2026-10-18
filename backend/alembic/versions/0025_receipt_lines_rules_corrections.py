"""receipts: where each item is printed on the photo, a chat's split rules by category, and what
people corrected on earlier receipts (reused on the next scan)

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-19 12:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '0025'
down_revision = '0024'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('receipt_items', sa.Column('source_box', postgresql.JSONB(), nullable=True))
    op.create_table(
        'split_rules',
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('category', sa.String(40), primary_key=True),
        sa.Column('user_ids', postgresql.ARRAY(sa.String(40)), nullable=False, server_default='{}'),
        sa.Column('updated_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        'receipt_corrections',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('conversation_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('store_key', sa.String(60), nullable=False),
        sa.Column('store_name', sa.String(120), nullable=True),
        sa.Column('kind', sa.String(20), nullable=False),
        sa.Column('original', sa.String(300), nullable=False),
        sa.Column('corrected', sa.String(300), nullable=False, server_default=''),
        sa.Column('times', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('conversation_id', 'store_key', 'kind', 'original', name='uq_receipt_correction'),
    )
    op.create_index('ix_receipt_corrections_chat', 'receipt_corrections', ['conversation_id', 'updated_at'])


def downgrade():
    op.drop_index('ix_receipt_corrections_chat', 'receipt_corrections')
    op.drop_table('receipt_corrections')
    op.drop_table('split_rules')
    op.drop_column('receipt_items', 'source_box')
