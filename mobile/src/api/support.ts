// src/api/support.ts
// Support requests to the ShareEven team (same as web/src/services/support.service.ts).
import { api, data } from './client';

export type SupportCategory = 'bug' | 'payment' | 'account' | 'feedback' | 'other';

export const SUPPORT_CATEGORIES: { value: SupportCategory; label: string }[] = [
  { value: 'bug', label: "Something isn't working" },
  { value: 'payment', label: 'Payments and ShareEven Pro' },
  { value: 'account', label: 'My account or sign-in' },
  { value: 'feedback', label: 'An idea or feedback' },
  { value: 'other', label: 'Something else' },
];

export interface SupportTicket {
  id: string;
  category: SupportCategory;
  subject: string;
  message: string;
  status: 'open' | 'closed';
  reply: string | null;
  replied_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export const supportApi = {
  mine: () => data<SupportTicket[]>(api.get('/support')),
  send: (body: { category: SupportCategory; subject: string; message: string; app_info?: string }) =>
    data<SupportTicket>(api.post('/support', body)),
};
