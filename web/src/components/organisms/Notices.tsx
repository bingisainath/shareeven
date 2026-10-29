// src/components/organisms/Notices.tsx
// Settings → Notices (messages from the ShareEven team) and the banner above the chat list while
// one is unread. Same as the Android app's Notices screen.

import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, Inbox, MessageSquareText } from 'lucide-react';
import { readAllNotices, useNotices } from '../../hooks/useNotices';
import { formatMessageTime } from '../../utils/dateFormat';

export const NoticesSection: React.FC = () => {
  const { notices, loaded } = useNotices();
  // Opening the page reads them (once they're loaded, so the banner goes too)
  useEffect(() => { if (loaded) readAllNotices(); }, [loaded, notices.length]);

  if (!loaded) return null;
  if (!notices.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-500">
        <Inbox className="w-8 h-8 text-muted-300" />
        <p className="text-sm">No notices. Replies to your support requests, updates on reports you make, and warnings appear here.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {notices.map((n) => {
        const warning = n.kind === 'warning';
        const Icon = warning ? CircleAlert : MessageSquareText;
        return (
          <li key={n.id} className={`flex gap-3 p-4 rounded-[15px] border ${warning ? 'border-warning-200 bg-warning-50' : 'border-muted-200 bg-white'}`}>
            <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${warning ? 'text-warning-700' : 'text-primary-700'}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-sm font-semibold text-muted-900">{n.title}</h3>
                <span className="text-xs text-muted-400">{formatMessageTime(n.created_at)}</span>
              </div>
              <p className="mt-1 text-sm text-muted-700 whitespace-pre-line">{n.body}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

/** Above the chat list while a notice is unread. */
export const NoticesBanner: React.FC = () => {
  const { notices, unread } = useNotices();
  if (!unread) return null;
  const warning = notices.some((n) => !n.read && n.kind === 'warning');
  return (
    <Link to="/settings/notices"
      className={`flex items-center gap-3 px-4 py-2.5 mb-1 rounded-xl text-sm ${warning ? 'bg-warning-50 text-warning-800' : 'bg-primary-50 text-primary-800'} hover:opacity-90`}>
      {warning ? <CircleAlert className="w-4 h-4 flex-shrink-0" /> : <MessageSquareText className="w-4 h-4 flex-shrink-0" />}
      <span className="flex-1 font-medium">
        {warning ? 'You have a warning from the ShareEven team' : `${unread === 1 ? 'A notice' : `${unread} notices`} from the ShareEven team`}
      </span>
      <span className="text-xs font-semibold underline">Read</span>
    </Link>
  );
};
