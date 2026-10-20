// src/components/molecules/AlbumGrid.tsx
// Four or more photos sent together show as one 2×2 grid ("+3" on the last tile), like WhatsApp.

import React from 'react';
import { Avatar } from '../atoms';
import Icon from '../atoms/Icon';
import { formatMessageTime } from '../../utils/dateFormat';
import { blurUri, resolveMediaUrl } from '../../utils/media';
import { useMediaSrc } from '../../crypto/media';
import type { Message } from '../../redux/slices/chatSlice';

interface Props {
  messages: Message[];
  isSent: boolean;
  isGroup?: boolean;
  onOpen: (messageId: string) => void;
  onMediaError?: () => void;
}

const AlbumGrid: React.FC<Props> = ({ messages, isSent, isGroup, onOpen, onMediaError }) => {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const extra = messages.length - 4;
  return (
    <div data-message-id={first.id} className={`flex gap-2 mb-3 ${isSent ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isSent && isGroup && <Avatar src={first.senderAvatar} alt={first.senderName || 'User'} size="sm" className="mt-auto" />}
      <div className={`flex flex-col ${isSent ? 'items-end' : 'items-start'}`}>
        {!isSent && isGroup && first.senderName && <span className="mb-1 ml-1 text-xs font-semibold text-primary-700">{first.senderName}</span>}
        <div className={`p-[3px] rounded-2xl ${isSent ? 'bg-primary-700 rounded-br-sm' : 'bg-white border border-muted-200 rounded-bl-sm'}`}>
          <div className="relative grid grid-cols-2 gap-0.5 w-64 sm:w-72 rounded-[13px] overflow-hidden" role="group" aria-label={`${messages.length} photos`}>
            {messages.slice(0, 4).map((m, i) => (
              <button key={m.id} type="button" onClick={() => onOpen(m.id)} className="relative aspect-square overflow-hidden bg-muted-100" aria-label={`Open photo ${i + 1} of ${messages.length}`}>
                <AlbumPhoto message={m} onMediaError={onMediaError} />
                {i === 3 && extra > 0 && (
                  <span className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-2xl font-semibold">+{extra}</span>
                )}
              </button>
            ))}
            <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/45 text-white text-[10px] pointer-events-none">
              {formatMessageTime(last.timestamp)}
              {isSent && last.status && (
                <Icon name={last.status === 'sent' ? 'check' : 'checkDouble'} size={14} className={last.status === 'read' ? 'text-secondary-300' : 'text-white'} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const AlbumPhoto: React.FC<{ message: Message; onMediaError?: () => void }> = ({ message: m, onMediaError }) => {
  const { src } = useMediaSrc(resolveMediaUrl(m.mediaUrl), m.mediaKey, m.mediaMime, m.mediaV2);
  return src
    ? <img src={src} alt={m.mediaFilename || 'Photo'} loading="lazy" onError={m.mediaKey ? undefined : onMediaError} className="w-full h-full object-cover" />
    : m.mediaBlur
      ? <span className="block w-full h-full overflow-hidden"><img src={blurUri(m.mediaBlur)} alt="" className="w-full h-full object-cover blur-md scale-110" /></span>
      : <span className="block w-full h-full animate-pulse" />;
};

/** Split a chat into single messages and albums (4+ captionless photos from one person in a row). */
export type ChatItem = { kind: 'message'; message: Message } | { kind: 'album'; messages: Message[] };

const ALBUM_GAP_MS = 2 * 60 * 1000;
const isAlbumPhoto = (m: Message) =>
  m.mediaType === 'image' && !!m.mediaUrl && !m.text && !m.isDeleted && !m.replyTo && m.e2e !== 'unreadable'
  && m.uploadProgress === undefined && !m.uploadFailed && m.messageType !== 'system' && !(m.reactions?.length);

export function groupAlbums(messages: Message[]): ChatItem[] {
  const items: ChatItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length >= 4) items.push({ kind: 'album', messages: run });
    else run.forEach((message) => items.push({ kind: 'message', message }));
    run = [];
  };
  for (const m of messages) {
    const prev = run[run.length - 1];
    if (isAlbumPhoto(m) && (!prev || (prev.senderId === m.senderId
        && new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() <= ALBUM_GAP_MS))) {
      run.push(m);
    } else {
      flush();
      if (isAlbumPhoto(m)) run.push(m);
      else items.push({ kind: 'message', message: m });
    }
  }
  flush();
  return items;
}

export default AlbumGrid;
