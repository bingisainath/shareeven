// src/components/organisms/ForwardDialog/index.tsx
// "Forward to…": pick up to 5 chats and send a copy of the message to each.

import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { Check, Search, SendHorizontal, X } from 'lucide-react';
import type { RootState } from '../../../redux/store';
import { Avatar } from '../../atoms';
import { messagePreview } from '../../../utils/media';
import type { Message } from '../../../redux/slices/chatSlice';

const MAX_TARGETS = 5;
const EMPTY: never[] = [];

interface Props {
  message: Message;
  onSend: (conversationIds: string[]) => void;
  onClose: () => void;
}

const ForwardDialog: React.FC<Props> = ({ message, onSend, onClose }) => {
  const conversations = useSelector((state: RootState) => state.chat?.conversations ?? EMPTY);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...conversations]
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.lastMessageTime || 0).getTime() - new Date(a.lastMessageTime || 0).getTime());
  }, [conversations, query]);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_TARGETS ? [...p, id] : p));

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40" onClick={onClose}>
      <div role="dialog" aria-label="Forward message" className="w-full sm:max-w-md h-[85dvh] sm:h-[70vh] flex flex-col bg-white sm:rounded-2xl rounded-t-2xl shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-muted-200">
          <h2 className="text-lg font-semibold text-muted-900">Forward to…</h2>
          <button type="button" onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-muted-100" aria-label="Close"><X className="w-5 h-5 text-muted-600" /></button>
        </div>
        <div className="px-4 py-2 border-b border-muted-100 text-xs text-muted-500 truncate">
          {messagePreview(message.text, message.mediaType, message.mediaFilename)}
        </div>
        <div className="px-4 py-2">
          <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-muted-200 bg-muted-50 focus-within:border-primary-500">
            <Search className="w-4 h-4 text-muted-400" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="flex-1 bg-transparent outline-none text-sm" />
          </label>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {list.map((c) => {
            const on = picked.includes(c.id);
            return (
              <li key={c.id}>
                <button type="button" onClick={() => toggle(c.id)} aria-pressed={on} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted-50 text-left">
                  <Avatar src={c.avatar} alt={c.name} size="md" group={c.isGroup} />
                  <span className="flex-1 min-w-0 truncate text-sm text-muted-900">{c.name}</span>
                  <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${on ? 'bg-primary-700 border-primary-700 text-white' : 'border-muted-300'}`}>
                    {on && <Check className="w-3 h-3" />}
                  </span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-4 py-6 text-sm text-center text-muted-500">No chats found</li>}
        </ul>
        <div className="flex items-center gap-3 px-4 py-3 border-t border-muted-200 mobile-nav-safe">
          <span className="flex-1 text-sm text-muted-600 truncate">
            {picked.length ? conversations.filter((c) => picked.includes(c.id)).map((c) => c.name).join(', ') : `Choose up to ${MAX_TARGETS} chats`}
          </span>
          <button
            type="button"
            disabled={!picked.length}
            onClick={() => { onSend(picked); onClose(); }}
            className="w-11 h-11 rounded-full bg-primary-700 hover:bg-primary-800 text-white flex items-center justify-center disabled:bg-muted-300"
            aria-label="Send forward"
          >
            <SendHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ForwardDialog;
