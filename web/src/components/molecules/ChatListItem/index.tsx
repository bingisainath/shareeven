// src/components/molecules/ChatListItem.tsx
import React from 'react';
import { Avatar, Typography } from '../../atoms';
import Icon from '../../atoms/Icon';
import { formatMessageTime } from '../../../utils/dateFormat';
import { Archive, ArchiveRestore, BellOff } from 'lucide-react';

/** Muted right now? (mutedUntil in the future) */
export const isMuted = (mutedUntil?: string | null) => !!mutedUntil && new Date(mutedUntil).getTime() > Date.now();

interface ChatListItemProps {
  id: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
  lastMessageTime?: string;
  unreadCount?: number;
  isOnline?: boolean;
  isActive?: boolean;
  isTyping?: boolean;
  isPinned?: boolean;
  isGroup?: boolean;
  mutedUntil?: string | null;
  isArchived?: boolean;
  typingText?: string; // e.g. "Alice is typing…" (defaults to "typing...")
  onClick?: () => void;
  onToggleArchive?: () => void;
  onTogglePin?: () => void;
  className?: string;
}

const ChatListItem: React.FC<ChatListItemProps> = ({
  id,
  name,
  avatar,
  lastMessage,
  lastMessageTime,
  unreadCount = 0,
  isOnline = false,
  isActive = false,
  isTyping = false,
  isPinned = false,
  isGroup = false,
  mutedUntil,
  isArchived = false,
  typingText,
  onClick,
  onTogglePin,
  onToggleArchive,
  className = ''
}) => {
  
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      aria-label={`${name}${unreadCount ? `, ${unreadCount} unread` : ''}`}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`
        relative group
        flex items-center gap-3 px-3 py-3
        rounded-[14px]
        ${isActive ? 'bg-primary-50' : 'hover:bg-primary-50/60'}
        transition-colors
        cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary-500
        ${className}
      `}
    >
      {/* Avatar with status */}
      <Avatar
        src={avatar}
        alt={name}
        size="lg"
        online={isOnline}
        group={isGroup}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name and time */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {isGroup && (
              <Icon name="users" size={14} className="text-muted-500 flex-shrink-0" />
            )}
            <Typography
              variant="body1"
              weight="semibold"
              className={`truncate font-bold ${isActive ? 'text-primary-800' : 'text-muted-900'}`}
            >
              {name}
            </Typography>
            {isMuted(mutedUntil) && <BellOff className="w-3.5 h-3.5 text-muted-400 flex-shrink-0" aria-label="Muted" />}
          </div>
          
          {lastMessageTime && (
            <span className={`text-xs flex-shrink-0 ml-2 ${unreadCount > 0 ? 'text-primary-600 font-semibold' : 'text-muted-400'}`}>
              {formatMessageTime(lastMessageTime)}
            </span>
          )}
        </div>

        {/* Last message or typing indicator */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            {isTyping ? (
              <div className="flex items-center gap-1.5">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-primary-600 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                  <span className="w-1.5 h-1.5 bg-primary-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                  <span className="w-1.5 h-1.5 bg-primary-600 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
                </div>
                <span className="text-xs text-primary-600 font-medium truncate">{typingText || 'typing...'}</span>
              </div>
            ) : (
              <Typography
                variant="body2"
                className={`truncate ${unreadCount > 0 ? 'text-muted-700 font-medium' : 'text-muted-500'}`}
              >
                {lastMessage || 'No messages yet'}
              </Typography>
            )}
          </div>

          {/* Unread badge */}
          {/* {unreadCount > 0 && !isTyping && (
            <Badge count={unreadCount} variant="primary" size="sm" />
          )} */}

          {/* Archive / unarchive on hover */}
          {onToggleArchive && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleArchive(); }}
              className="flex-shrink-0 p-1 -my-1 rounded-md text-muted-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-primary-100 transition-opacity"
              title={isArchived ? 'Unarchive chat' : 'Archive chat'}
              aria-label={isArchived ? 'Unarchive chat' : 'Archive chat'}
            >
              {isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            </button>
          )}

          {/* Pin: always shown when pinned; on hover (or focus), a button to pin/unpin */}
          {onTogglePin && !isArchived ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              className={`flex-shrink-0 p-1 -my-1 rounded-md transition-opacity hover:bg-primary-100 ${
                isPinned ? 'text-primary-600' : 'text-muted-400 opacity-0 group-hover:opacity-100 focus:opacity-100'
              }`}
              title={isPinned ? 'Unpin chat' : 'Pin chat'}
              aria-label={isPinned ? 'Unpin chat' : 'Pin chat'}
            >
              <Icon name="pin" size={14} />
            </button>
          ) : isPinned && (
            <Icon name="pin" size={14} className="flex-shrink-0 text-primary-600" />
          )}

          {/* ✅ Unread count badge */}
          {unreadCount > 0 && (
            <span className={`flex-shrink-0 inline-flex items-center justify-center min-w-[22px] h-[22px] px-2 text-xs font-bold text-white rounded-full ${isMuted(mutedUntil) ? 'bg-muted-400' : 'bg-primary-600'}`}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
      </div>

      {/* Active indicator line */}
      {isActive && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-8 bg-primary-700 rounded-r-full" />
      )}
    </div>
  );
};

export default ChatListItem;