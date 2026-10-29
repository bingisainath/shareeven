// src/services/support.service.ts
// Support requests to the ShareEven team, and (app admins) answering them.
import api from '../utils/axios';

const V1 = '/api/v1';
const data = <T>(promise: Promise<{ data: { data: T } }>) => promise.then(r => r.data.data);

export type SupportCategory = 'bug' | 'payment' | 'account' | 'feedback' | 'other';

export const SUPPORT_CATEGORIES: { value: SupportCategory; label: string }[] = [
  { value: 'bug', label: 'Something isn\'t working' },
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

export interface SupportTicketForAdmin extends SupportTicket {
  app_info: string | null;
  user: { id: string; username: string; name: string | null; avatar: string | null };
}

export const supportService = {
  mine: () => data<SupportTicket[]>(api.get(`${V1}/support`)),
  send: (body: { category: SupportCategory; subject: string; message: string; app_info?: string }) =>
    data<SupportTicket>(api.post(`${V1}/support`, body)),
  inbox: (status: 'open' | 'closed') => data<SupportTicketForAdmin[]>(api.get(`${V1}/admin/support`, { params: { status } })),
  reply: (id: string, reply: string, close: boolean) => data(api.post(`${V1}/admin/support/${id}/reply`, { reply, close })),
  close: (id: string) => data(api.post(`${V1}/admin/support/${id}/close`)),
};
