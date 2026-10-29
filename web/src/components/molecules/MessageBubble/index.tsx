// src/components/molecules/MessageBubble.tsx
import React, { useRef, useState } from 'react';
import { Avatar } from '../../atoms';
import Icon from '../../atoms/Icon';
import { Download, Flag, Forward, Loader2, Lock, Play, RotateCw, ShieldAlert, X } from 'lucide-react';
import VoiceNotePlayer from '../VoiceNotePlayer';
import { formatMessageTime } from '../../../utils/dateFormat';
import { blurUri, formatFileSize, mediaBoxStyle } from '../../../utils/media';
import { downloadDecrypted, useMediaSrc } from '../../../crypto/media';
import { UNREADABLE_TEXT } from '../../../crypto/messages';
import { toast } from 'react-toastify';
import type { Reaction, ReplyPreview } from '../../../redux/slices/chatSlice';

type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

const STATUS_LABELS: Record<MessageStatus, string> = {
  sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent',
};

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
// Height the action bar needs above a message (px); with less room below the chat's top it opens underneath
const ACTION_BAR_ROOM = 44;

interface MessageBubbleProps {
  id: string;
  text: string;
  timestamp: string;
  isSent: boolean;
  status?: MessageStatus;
  senderName?: string; // For group chats
  senderAvatar?: string; // For group chats
  senderColor?: string; // For group chat user identification
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'file';
  mediaDuration?: number;
  mediaFilename?: string;
  mediaSize?: number;
  mediaThumbnail?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  // End-to-end encrypted media: the file's key (the file is decrypted in the browser) and type
  mediaKey?: string;
  mediaMime?: string;
  thumbKey?: string;
  e2e?: 'encrypted' | 'unreadable' | 'pending';
  mediaV2?: { sha256: string; size: number }; // v2 files (PMV2 format)
  thumbV2?: { sha256: string; size: number };
  mediaBlur?: string;
  e2eUnverified?: boolean;
  uploadProgress?: number; // 0-100 while the attachment uploads
  uploadFailed?: boolean;
  onCancelUpload?: () => void;
  onRetryUpload?: () => void;
  onRetrySend?: () => void; // a text message that didn't send
  onDiscard?: () => void;
  onForward?: () => void;
  onReport?: () => void; // someone else's message
  onDownload?: () => void;
  isGroup?: boolean;
  isDeleted?: boolean;
  editedAt?: string | null;
  replyTo?: ReplyPreview | null;
  reactions?: Reaction[];
  currentUserId?: string;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onJumpToMessage?: (messageId: string) => void;
  onOpenImage?: () => void;
  onMediaError?: () => void; // e.g. the signed link expired
  className?: string;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  id,
  text,
  timestamp,
  isSent,
  status = 'sent',
  senderName,
  senderAvatar,
  senderColor = '#543f7d',
  mediaUrl,
  mediaType,
  mediaFilename,
  mediaSize,
  mediaThumbnail,
  mediaWidth,
  mediaHeight,
  mediaDuration,
  mediaKey,
  mediaMime,
  thumbKey,
  e2e,
  e2eUnverified,
  mediaV2,
  thumbV2,
  mediaBlur,
  uploadProgress,
  uploadFailed,
  onCancelUpload,
  onRetryUpload,
  onRetrySend,
  onDiscard,
  onForward,
  onReport,
  onDownload,
  isGroup = false,
  isDeleted = false,
  editedAt,
  replyTo,
  reactions = [],
  currentUserId,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onJumpToMessage,
  onOpenImage,
  onMediaError,
  className = ''
}) => {
  const [showActions, setShowActions] = useState(false);
  const box = mediaBoxStyle(mediaWidth, mediaHeight);
  // Encrypted videos are only downloaded (and decrypted) once someone presses play
  const [playVideo, setPlayVideo] = useState(false);
  const encryptedVideo = mediaType === 'video' && !!mediaKey;
  const media = useMediaSrc(encryptedVideo && !playVideo ? undefined : mediaUrl, mediaType === 'file' ? undefined : mediaKey, mediaMime, mediaV2);
  const poster = useMediaSrc(mediaThumbnail, thumbKey, 'image/jpeg', thumbV2);
  const [saving, setSaving] = useState(false); // the file is downloading: its icon spins (the toast shows how far)
  const saveEncryptedFile = () => {
    if (saving) return;
    setSaving(true);
    downloadDecrypted(mediaUrl!, mediaKey!, mediaMime, mediaFilename || 'file', mediaV2).finally(() => setSaving(false));
  };
  // Photos and videos fill the bubble with an even, thin frame; a captionless photo shows the time on the picture
  const visual = !isDeleted && !!mediaUrl && (mediaType === 'image' || mediaType === 'video');
  const timeOnMedia = visual && mediaType === 'image' && !text;
  const lastPointerType = useRef<string>('mouse');

  // The action bar sits just above the message so it never covers the text. Near the top of the
  // chat there's no room above (it would be cut off), so it opens just below instead.
  const columnRef = useRef<HTMLDivElement>(null);
  const [actionsBelow, setActionsBelow] = useState(false);
  const toggleActions = (open?: boolean) => setShowActions(was => {
    const next = open ?? !was;
    const column = columnRef.current;
    if (next && !was && column) {
      const log = column.closest('[role="log"]');
      setActionsBelow(column.getBoundingClientRect().top - (log?.getBoundingClientRect().top ?? 0) < ACTION_BAR_ROOM);
    }
    return next;
  });

  const statusIcons: Record<MessageStatus, React.ReactElement> = {
    sending: <Icon name="clock" size={14} className="text-white/70 animate-pulse" />,
    sent: <Icon name="check" size={14} className="text-white/70" />,
    delivered: <Icon name="checkDouble" size={14} className="text-white/70" />,
    read: <Icon name="checkDouble" size={14} className="text-sky-300" />,
    failed: <Icon name="xCircle" size={14} className="text-accent-400" />
  };

  // Pending/failed messages don't exist on the server yet, so they can't be acted on
  const canAct = !isDeleted && !id.startsWith('temp-');
  const hasActions = canAct && !!(onReply || onReact || onEdit || onDelete || onForward || onDownload || onReport);

  // Mouse users get the action bar on hover; touch users toggle it with a tap.
  // (Touch also fires emulated mouse events, so filter by pointer type.)
  const handleBubbleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('a, video, button') || lastPointerType.current === 'mouse') return;
    if (hasActions) toggleActions();
  };

  return (
    <div
      data-message-id={id}
      className={`
        flex gap-2 mb-3 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary-400
        ${isSent ? 'flex-row-reverse' : 'flex-row'}
        ${className}
      `}
      onPointerDown={(e) => { lastPointerType.current = e.pointerType; }}
      onPointerEnter={(e) => { lastPointerType.current = e.pointerType; if (e.pointerType === 'mouse' && hasActions) toggleActions(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setShowActions(false); }}
      /* Keyboard: Tab to a message, Enter (or Space) shows its actions, Escape hides them */
      tabIndex={hasActions ? 0 : undefined}
      aria-label={hasActions ? `${isSent ? 'You' : senderName || 'Message'}: ${text || mediaFilename || mediaType || 'attachment'}. Press Enter for actions` : undefined}
      onKeyDown={(e) => {
        if (!hasActions || e.target !== e.currentTarget) {
          if (e.key === 'Escape') setShowActions(false);
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleActions(); }
        if (e.key === 'Escape') setShowActions(false);
      }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && lastPointerType.current !== 'mouse') setShowActions(false); }}
    >
      {/* Avatar for received messages in group chats */}
      {!isSent && isGroup && (
        <Avatar
          src={senderAvatar}
          alt={senderName || 'User'}
          size="sm"
          className="mt-auto"
        />
      )}

      <div ref={columnRef} className={`relative flex flex-col min-w-0 max-w-[85%] sm:max-w-[75%] ${isSent ? 'items-end' : 'items-start'}`}>
        {/* Sender name for group chats */}
        {!isSent && isGroup && senderName && (
          <span className="mb-1 ml-3 text-xs font-semibold" style={{ color: senderColor }}>
            {senderName}
          </span>
        )}

        {/* Message bubble */}
        <div
          onClick={handleBubbleClick}
          className={`
            relative max-w-full
            ${visual ? 'p-[3px]' : 'px-4 py-2.5'}
            rounded-2xl
            ${isSent
              ? 'bg-primary-700 text-white rounded-br-sm shadow-[0_4px_12px_rgba(84,63,125,0.18)]'
              : visual
                ? 'bg-white text-muted-900 rounded-bl-sm shadow-[0_2px_8px_rgba(25,18,39,0.06)]'
                : 'bg-white text-muted-900 rounded-bl-sm shadow-[0_2px_8px_rgba(25,18,39,0.06)]'
            }
            transition-all duration-200
            animate-scale-in
          `}
        >
          {isDeleted ? (
            <p className={`text-sm italic flex items-center gap-1.5 ${isSent ? 'text-white/80' : 'text-muted-500'}`}>
              <Icon name="xCircle" size={14} />
              {isSent ? 'You deleted this message' : 'This message was deleted'}
            </p>
          ) : (
            <>
              {/* Quoted message this one replies to */}
              {replyTo && (
                <button
                  type="button"
                  onClick={() => onJumpToMessage?.(replyTo.id)}
                  className={`block w-full text-left ${visual ? 'mb-[3px]' : 'mb-2'} px-3 py-1.5 rounded-lg border-l-4 ${
                    isSent ? 'bg-white/15 border-white/60' : 'bg-muted-50 border-primary-500'
                  }`}
                >
                  <span className={`block text-xs font-semibold ${isSent ? 'text-white' : 'text-primary-700'}`}>
                    {replyTo.senderId === currentUserId ? 'You' : replyTo.senderName || 'Message'}
                  </span>
                  <span className={`block text-xs truncate ${replyTo.isDeleted ? 'italic' : ''} ${isSent ? 'text-white/80' : 'text-muted-600'}`}>
                    {replyTo.text}
                  </span>
                </button>
              )}

              {e2e === 'pending' && (
                <p className={`text-sm italic flex items-center gap-1.5 ${isSent ? 'text-white/80' : 'text-muted-500'}`}>
                  <Lock className="w-3.5 h-3.5 flex-shrink-0 animate-pulse" />
                  Waiting for this message…
                </p>
              )}
              {e2e === 'unreadable' && (
                <p className={`text-sm italic flex items-center gap-1.5 ${isSent ? 'text-white/80' : 'text-muted-500'}`}>
                  <Lock className="w-3.5 h-3.5 flex-shrink-0" />
                  {UNREADABLE_TEXT}
                </p>
              )}

              {/* Media content */}
              {mediaUrl && e2e !== 'unreadable' && e2e !== 'pending' && (
                <div className={`relative ${visual ? (text ? 'mb-1.5' : '') : text ? 'mb-2' : 'mb-1'}`}>
                  {mediaType === 'image' && (
                    <button
                      type="button"
                      onClick={onOpenImage}
                      className={`block overflow-hidden rounded-[13px] max-w-full ${box ? (isSent ? 'bg-white/10' : 'bg-muted-100') : ''}`}
                      style={box}
                      title="View photo"
                    >
                      {media.src ? (
                        <img
                          src={media.src}
                          alt={mediaFilename || 'Shared image'}
                          loading="lazy"
                          onError={mediaKey ? undefined : onMediaError}
                          className={box ? 'w-full h-full object-cover' : 'max-w-full sm:max-w-xs max-h-64 object-cover'}
                        />
                      ) : mediaBlur && !media.failed ? (
                        // the tiny preview from inside the message, blurred, until the photo is decrypted
                        <img src={blurUri(mediaBlur)} alt="" className={`${box ? 'w-full h-full' : 'w-56 h-40'} object-cover blur-md scale-110`} />
                      ) : (
                        <span className={`flex items-center justify-center text-xs ${box ? 'w-full h-full' : 'w-56 h-40'} ${isSent ? 'text-white/70' : 'text-muted-400'}`}>
                          {media.failed ? "Couldn't decrypt this photo" : <Lock className="w-5 h-5 animate-pulse" />}
                        </span>
                      )}
                    </button>
                  )}
                  {encryptedVideo && !media.src && (
                    <button
                      type="button"
                      onClick={() => setPlayVideo(true)}
                      style={box}
                      className={`relative block overflow-hidden rounded-[13px] max-w-full bg-black ${box ? '' : 'w-64 h-40'}`}
                      title="Play video"
                      aria-label="Play video"
                    >
                      {poster.src ? <img src={poster.src} alt="" className="w-full h-full object-cover opacity-90" />
                        : mediaBlur && <img src={blurUri(mediaBlur)} alt="" className="w-full h-full object-cover blur-md scale-110 opacity-90" />}
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center text-white">
                          {playVideo && !media.failed ? <Lock className="w-5 h-5 animate-pulse" /> : <Play className="w-6 h-6 fill-white" />}
                        </span>
                      </span>
                      {media.failed && <span className="absolute bottom-2 left-2 text-xs text-white">Couldn't decrypt this video</span>}
                    </button>
                  )}
                  {mediaType === 'video' && media.src && (
                    <video
                      src={media.src}
                      poster={poster.src}
                      autoPlay={encryptedVideo}
                      controls
                      playsInline
                      // With a poster nothing needs to load until the user presses play
                      preload={mediaThumbnail ? 'none' : 'metadata'}
                      onError={mediaKey ? undefined : onMediaError}
                      style={box}
                      className={box ? 'block max-w-full rounded-[13px] bg-black object-cover' : 'block rounded-[13px] max-w-full sm:max-w-xs max-h-64 bg-black'}
                    />
                  )}
                  {mediaType === 'audio' && (
                    media.src
                      ? <VoiceNotePlayer src={media.src} duration={mediaDuration} isSent={isSent} onError={mediaKey ? undefined : onMediaError} />
                      : <span className={`flex items-center gap-2 text-xs py-2 ${isSent ? 'text-white/70' : 'text-muted-500'}`}><Lock className="w-3.5 h-3.5" />{media.failed ? "Couldn't decrypt this voice message" : 'Decrypting…'}</span>
                  )}
                  {mediaType === 'file' && mediaKey && (
                    <button type="button" onClick={saveEncryptedFile} title={saving ? 'Downloading…' : 'Save'} aria-busy={saving} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left ${isSent ? 'bg-white/15 hover:bg-white/25' : 'bg-muted-100 hover:bg-muted-200'}`}>
                      {saving ? <Loader2 className="w-5 h-5 animate-spin" aria-label="Downloading" /> : <Icon name="attach" size={20} />}
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate max-w-[12rem]">{mediaFilename || 'File'}</span>
                        {mediaSize ? <span className="text-[11px] opacity-70">{formatFileSize(mediaSize)}</span> : null}
                      </span>
                    </button>
                  )}
                  {mediaType === 'file' && !mediaKey && (
                    <a href={mediaUrl} target="_blank" rel="noopener noreferrer" download={mediaFilename} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left ${isSent ? 'bg-white/15 hover:bg-white/25' : 'bg-muted-100 hover:bg-muted-200'}`}>
                      <Icon name="attach" size={20} />
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate max-w-[12rem]">{mediaFilename || 'File'}</span>
                        {mediaSize ? <span className="text-[11px] opacity-70">{formatFileSize(mediaSize)}</span> : null}
                      </span>
                    </a>
                  )}

                  {/* Uploading: percentage and a cancel button */}
                  {uploadProgress !== undefined && onCancelUpload && (
                    <button
                      type="button"
                      onClick={onCancelUpload}
                      className="absolute top-1.5 right-1.5 flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-black/60 text-white text-[11px]"
                      title="Cancel upload"
                      aria-label="Cancel upload"
                    >
                      {uploadProgress >= 99 ? 'Processing' : `${uploadProgress}%`}
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Upload progress */}
                  {uploadProgress !== undefined && (
                    <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/20 rounded-b-[13px] overflow-hidden">
                      <div
                        className="h-full bg-white transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  )}

                  {timeOnMedia && uploadProgress === undefined && (
                    <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/45 text-white pointer-events-none">
                      <span className="text-[10px]">{formatMessageTime(timestamp)}</span>
                      {isSent && status && <span role="img" aria-label={STATUS_LABELS[status]} title={STATUS_LABELS[status]} className={`flex-shrink-0 ${status === 'read' ? '' : '[&_svg]:!text-white'}`}>{statusIcons[status]}</span>}
                    </div>
                  )}
                </div>
              )}

              {/* Text content */}
              {text && (
                <p className={`text-sm break-words whitespace-pre-wrap ${visual ? 'px-2' : ''} ${isSent ? 'text-white' : 'text-muted-900'}`}>
                  {text}
                </p>
              )}
            </>
          )}

          {/* Timestamp and status */}
          <div className={`${timeOnMedia ? 'hidden' : 'flex'} items-center gap-1 ${visual ? 'mt-0.5 px-2 pb-0.5' : 'mt-1'} ${isSent ? 'justify-end' : 'justify-start'}`}>
            {editedAt && !isDeleted && (
              <span className={`text-[10px] italic ${isSent ? 'text-white/70' : 'text-muted-400'}`}>edited</span>
            )}
            <span className={`text-[10px] ${isSent ? 'text-white/70' : 'text-muted-400'}`}>
              {formatMessageTime(timestamp)}
            </span>
            {isSent && status && !isDeleted && (
              <span role="img" aria-label={STATUS_LABELS[status]} title={STATUS_LABELS[status]} className="flex-shrink-0">
                {statusIcons[status]}
              </span>
            )}
          </div>
        </div>

        {e2eUnverified && (
          <p className="flex items-center gap-1 mt-1 text-[11px] text-warning-700" title="Signed with a key that isn't this person's. It may not be from them.">
            <ShieldAlert className="w-3.5 h-3.5" /> Couldn't verify the sender
          </p>
        )}

        {/* A text that didn't send: try again or drop it */}
        {status === 'failed' && !uploadFailed && onRetrySend && (
          <div className="flex items-center justify-end gap-2 mt-1 text-xs" role="alert">
            <span className="text-accent-600">Not sent</span>
            <button type="button" onClick={onRetrySend} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary-50 text-primary-700 hover:bg-primary-100">
              <RotateCw className="w-3 h-3" /> Retry
            </button>
            <button type="button" onClick={onDiscard} className="px-2 py-0.5 rounded-md text-muted-600 hover:bg-muted-100">Remove</button>
          </div>
        )}

        {/* Upload failed: try again or drop it */}
        {uploadFailed && (
          <div className="flex items-center gap-2 mt-1 text-xs">
            <span className="text-accent-600">Not sent</span>
            <button type="button" onClick={onRetryUpload} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary-50 text-primary-700 hover:bg-primary-100">
              <RotateCw className="w-3 h-3" /> Retry
            </button>
            <button type="button" onClick={onCancelUpload} className="px-2 py-0.5 rounded-md text-muted-600 hover:bg-muted-100">Remove</button>
          </div>
        )}

        {/* Reactions */}
        {reactions.length > 0 && !isDeleted && (
          <div className={`flex flex-wrap gap-1 mt-1 ${isSent ? 'justify-end' : 'justify-start'}`}>
            {reactions.map(reaction => {
              const mine = !!currentUserId && reaction.userIds.includes(currentUserId);
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  onClick={() => onReact?.(reaction.emoji)}
                  title={mine ? 'Remove your reaction' : 'React'}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs shadow-sm transition-colors ${
                    mine ? 'bg-primary-50 border-primary-300' : 'bg-white border-muted-200 hover:bg-muted-50'
                  }`}
                >
                  <span>{reaction.emoji}</span>
                  {reaction.userIds.length > 1 && (
                    <span className="text-muted-600 font-medium">{reaction.userIds.length}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Action bar: quick reactions, reply, edit, delete. Floats just outside the bubble (above, or
            below near the top of the chat) so it never hides the text or moves the message. The padding
            on the side facing the bubble bridges the gap, so moving the mouse onto the bar keeps it open. */}
        {showActions && hasActions && (
          <div className={`absolute z-20 ${actionsBelow ? 'top-full pt-1' : 'bottom-full pb-1'} ${isSent ? 'right-0' : 'left-0'}`}>
            <div className={`flex items-center gap-0.5 whitespace-nowrap px-1 py-0.5 bg-white border border-muted-200 rounded-full shadow-elevated animate-fade-in`}>
              {onReact && QUICK_REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => { onReact(emoji); setShowActions(false); }}
                  className="h-7 w-7 flex items-center justify-center text-base rounded-full hover:bg-muted-100 transition-colors"
                  title={`React ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
              {onReply && (
                <button
                  type="button"
                  onClick={() => { onReply(); setShowActions(false); }}
                  className="p-1.5 hover:bg-muted-100 rounded-full transition-colors"
                  title="Reply"
                >
                  <Icon name="forward" size={16} className="text-muted-500 rotate-180" />
                </button>
              )}
              {onForward && (
                <button
                  type="button"
                  onClick={() => { onForward(); setShowActions(false); }}
                  className="p-1.5 hover:bg-muted-100 rounded-full transition-colors"
                  title="Forward"
                  aria-label="Forward"
                >
                  <Forward className="w-4 h-4 text-muted-500" />
                </button>
              )}
              {onDownload && mediaUrl && (
                <button
                  type="button"
                  onClick={() => { onDownload(); setShowActions(false); }}
                  className="p-1.5 hover:bg-muted-100 rounded-full transition-colors"
                  title="Download"
                  aria-label="Download"
                >
                  <Download className="w-4 h-4 text-muted-500" />
                </button>
              )}
              {isSent && onEdit && (
                <button
                  type="button"
                  onClick={() => { onEdit(); setShowActions(false); }}
                  className="p-1.5 hover:bg-muted-100 rounded-full transition-colors"
                  title="Edit"
                >
                  <Icon name="edit" size={16} className="text-muted-500" />
                </button>
              )}
              {!isSent && onReport && (
                <button
                  type="button"
                  onClick={() => { onReport(); setShowActions(false); }}
                  className="p-1.5 hover:bg-accent-50 rounded-full transition-colors"
                  title="Report"
                  aria-label="Report"
                >
                  <Flag className="w-4 h-4 text-muted-500" />
                </button>
              )}
              {isSent && onDelete && (
                <button
                  type="button"
                  onClick={() => { onDelete(); setShowActions(false); }}
                  className="p-1.5 hover:bg-accent-50 rounded-full transition-colors"
                  title="Delete for everyone"
                >
                  <Icon name="delete" size={16} className="text-accent-500" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageBubble;
