// src/utils/events.ts
// Window events that let non-component code talk to the app.

/** detail: path. Home navigates there (used by toasts and notifications). */
export const NAVIGATE_EVENT = 'papyris:navigate';

/** detail: conversation id. Fired when a conversation's details change (info panel refreshes). */
export const CONVERSATION_UPDATED_EVENT = 'papyris:conversation-updated';

/** detail: { conversationId, expenseId?, action }. An expense, payment or expense setting changed. */
export const EXPENSE_CHANGED_EVENT = 'papyris:expense-changed';

/** detail: { receiptId, conversationId, status, error }. The AI finished reading a receipt. */
export const RECEIPT_READY_EVENT = 'papyris:receipt-ready';

/** detail: { receiptId, conversationId, step, label }. The AI moved on to the next step of reading a receipt. */
export const RECEIPT_PROGRESS_EVENT = 'papyris:receipt-progress';

/** detail: { conversationId, expenseId? }. Open the add-expense sheet (or an expense) in a chat. */
export const OPEN_EXPENSE_EVENT = 'papyris:open-expense';
