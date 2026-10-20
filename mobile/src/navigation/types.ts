// src/navigation/types.ts
export type AuthStackParams = {
  Login: undefined;
  SignUp: undefined;
  VerifyEmail: { email: string; justSent?: boolean };
  ForgotPassword: undefined;
};

export type TabParams = {
  Chats: undefined;
  Expenses: undefined;
  Settings: undefined;
};

export type AppStackParams = {
  Tabs: undefined;
  Chat: { conversationId: string; messageId?: string }; // messageId: open at that message (search)
  ChatInfo: { conversationId: string; addMembers?: boolean };
  SharedMedia: { conversationId: string };
  NewChat: undefined;
  NewGroup: undefined;
  ChatExpenses: { conversationId: string };
  AddExpense: { conversationId: string; expenseId?: string };
  ScanReceipt: { conversationId: string; receiptId?: string };
  ExpenseDetail: { expenseId: string };
  Profile: undefined;
  Account: undefined;
  Backup: undefined;
  ReceiptScanning: undefined;
  Plan: undefined;
  Help: undefined;
  StoreDiscounts: undefined;
  Encryption: undefined;
  Sessions: undefined;
  DeleteAccount: undefined;
  BlockedPeople: undefined;
  Notices: undefined;
  // What's being reported; messageText is shared only if the reporter chooses to
  Report: { title: string; userId?: string; userName?: string; conversationId?: string; messageId?: string; messageText?: string };
};
