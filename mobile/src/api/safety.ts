// src/api/safety.ts
// Blocking people and reporting abuse (same as web/src/services/safety.service.ts).
import { api, data } from './client';

export type ReportReason = 'spam' | 'harassment' | 'scam' | 'inappropriate' | 'impersonation' | 'other';

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam or unwanted messages' },
  { value: 'scam', label: 'Scam or fraud (money, links, fake requests)' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate', label: 'Inappropriate or offensive content' },
  { value: 'impersonation', label: 'Pretending to be someone else' },
  { value: 'other', label: 'Something else' },
];

export interface BlockedPerson { id: string; username: string; name: string | null; avatar: string | null; blocked_at: string }

export const safetyApi = {
  blocked: () => data<BlockedPerson[]>(api.get('/users/blocked')),
  block: (userId: string) => data(api.post(`/users/${userId}/block`)),
  unblock: (userId: string) => data(api.delete(`/users/${userId}/block`)),
  report: (body: {
    user_id?: string; conversation_id?: string; message_id?: string; reason: ReportReason;
    details?: string; evidence?: string; block?: boolean;
  }) => data<{ reported: boolean; blocked: boolean }>(api.post('/reports', body)),
  notices: () => data<{ notices: Notice[]; unread: number }>(api.get('/notices')),
  readNotices: (ids?: string[]) => data(api.post('/notices/read', ids ? { ids } : {})),
};

/** A message from the ShareEven team: a warning, or the outcome of a report you made. */
export interface Notice {
  id: string;
  kind: 'warning' | 'report_update' | 'pro_reminder';
  title: string;
  body: string;
  reason: string | null;
  created_at: string;
  read: boolean;
}
