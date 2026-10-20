// src/components/organisms/ChatWindow.tsx

import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { MessageBubble, MessageInput } from '../../molecules';
import { Avatar } from '../../atoms';
import {
  useConversationRoom,
  useSendMessage,
  useTypingIndicator,
  useReadReceipt,
} from '../../../hooks/useWebSocket';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../../redux/store';
import { selectIsConnected, selectTypingNames } from '../../../redux/slices/websocketSlice';
import { fetchMessages, fetchOlderMessages } from '../../../redux/actions/chatActions';
import { downloadMedia, messagePreview, resolveMediaUrl } from '../../../utils/media';
import { applyMessageUpdate, clearUnreadCount, forgetUnreadWhenOpened, setBlocked } from '../../../redux/slices/chatSlice';
import { safetyService } from '../../../services/safety.service';
import ReportDialog from '../ReportDialog';
import type { ReportTarget } from '../ReportDialog';
import type { Message, ReplyPreview } from '../../../redux/slices/chatSlice';
import { chatService } from '../../../services/chat.service';
import { parseApiError } from '../../../utils/apiError';
import { toast } from 'react-toastify';
import ConversationInfoPanel from '../ConversationInfoPanel';
import MediaViewer from '../MediaViewer';
import type { ViewerImage } from '../MediaViewer';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Lock, LockOpen, Search, ShieldAlert, UserPlus } from 'lucide-react';
import ChatSearch from './ChatSearch';
import { downloadDecrypted } from '../../../crypto/media';
import { sealFor } from '../../../crypto/messages';
import { useChatEncryption } from '../../../crypto/useChatEncryption';
import { editV2 } from '../../../crypto/v2-platform/chat';
import { useKeyChanges, useTrustActions } from '../../../crypto/v2-platform/trust';
import { mediaPayloadOf } from '../../../redux/actions/websocketActions';
import AddExpenseSheet from '../../expenses/AddExpenseSheet';
import ExpenseCard from '../../expenses/ExpenseCard';
import ExpenseDetail from '../../expenses/ExpenseDetail';
import ForwardDialog from '../ForwardDialog';
import AlbumGrid, { groupAlbums } from '../../molecules/AlbumGrid';
import type { OutgoingAttachment } from '../../molecules/MessageInput';
import { cancelUpload, forwardMessage, retryUpload, retryText, discardFailed } from '../../../redux/actions/websocketActions';
import { confirmDialog } from '../ConfirmDialog';

// Stable empty value for selectors: returning a new [] each time makes components re-render
const EMPTY: never[] = [];

interface ChatWindowProps {
  conversationId: string;
  conversationName: string;
  conversationAvatar?: string;
  isGroup?: boolean;
  memberCount?: number;
  isOnline?: boolean;
  currentUserId: string;
  onBack?: () => void;
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  conversationId,
  conversationName,
  conversationAvatar,
  isGroup,
  memberCount,
  isOnline,
  currentUserId,
  onBack
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const encryption = useChatEncryption(conversationId);
  const conversationMembers = useSelector((state: RootState) => state.chat.conversations.find(c => c.id === conversationId)?.members) || EMPTY;
  // Unread when this chat was opened (the list clears the count as it opens the chat)
  const unreadCount = useSelector((state: RootState) =>
    state.chat.conversations.find(c => c.id === conversationId)?.unreadCount || state.chat.unreadWhenOpened?.[conversationId] || 0);
  const keyChanges = useKeyChanges(conversationMembers);
  const trustActions = useTrustActions();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastRenderedMessageId = useRef<string | undefined>(undefined);
  const scrollHeightBeforePrepend = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Scrolling: are we at the newest messages? How many arrived while reading further up?
  const nearBottom = useRef(true);
  const [newBelow, setNewBelow] = useState(0);
  const [farFromBottom, setFarFromBottom] = useState(false);
  // The "New messages" line: above the oldest message that was unread when this chat opened.
  // Worked out while rendering (not in an effect) so the first scroll can land on it.
  const openedFor = useRef<string | null>(null);
  const unreadAtOpen = useRef(0);
  const firstUnread = useRef<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ReplyPreview | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [infoAddMembers, setInfoAddMembers] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const lastMediaRefresh = useRef(0);

  // Expenses: ?receipt=<id> opens a receipt to review, ?expense=<id> opens an expense
  const [searchParams, setSearchParams] = useSearchParams();
  const [searching, setSearching] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const openReceiptId = searchParams.get('receipt');
  const openExpenseId = searchParams.get('expense');
  const closeExpenseView = () => setSearchParams({}, { replace: true });

  const isConnected = useSelector(selectIsConnected);
  const blockedUserId = useSelector((state: RootState) => {
    const c = state.chat.conversations.find(x => x.id === conversationId);
    return c?.isBlocked ? c.otherUserId || null : null;
  });
  const [unblocking, setUnblocking] = useState(false);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const unblock = async () => {
    if (!blockedUserId) return;
    setUnblocking(true);
    try {
      await safetyService.unblock(blockedUserId);
      dispatch(setBlocked({ userId: blockedUserId, blocked: false }));
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setUnblocking(false);
    }
  };
  // const onlineUsers = useSelector(selectOnlineUsers);

  const lastMarkedMessageId = useRef<string | undefined>(undefined);

  // ✅ Track active conversation globally
  useEffect(() => {
    (window as any).__activeConversationId = conversationId;

    return () => {
      (window as any).__activeConversationId = null;
    };
  }, [conversationId]);

  // ✅ WebSocket: Auto join/leave conversation room
  useConversationRoom(conversationId);

  // ✅ WebSocket: Get messages from Redux (populated by WebSocket)
  const messages = useSelector((state: RootState) =>
    state.chat?.messages[conversationId] ?? EMPTY
  );
  const hasMoreMessages = useSelector((state: RootState) =>
    state.chat?.hasMoreMessages?.[conversationId] || false
  );

  // ✅ WebSocket: Send message functionality
  const { sendMessage } = useSendMessage();

  // ✅ WebSocket: Typing indicators
  const { isTyping, typingUsers, startTyping, stopTyping } = useTypingIndicator(conversationId);

  const typingNames = useSelector(selectTypingNames);
  const typingText = !isGroup
    ? `${conversationName} is typing`
    : typingUsers.length > 1
      ? `${typingUsers.length} people are typing`
      : `${typingNames[typingUsers[0]] || 'Someone'} is typing`;

  // ✅ WebSocket: Read receipts
  const { markAsRead } = useReadReceipt(conversationId);
  if (openedFor.current !== conversationId) {
    openedFor.current = conversationId;
    unreadAtOpen.current = unreadCount;
    firstUnread.current = null;
  }
  if (!firstUnread.current && unreadAtOpen.current > 0 && messages.length) {
    const fromOthers = messages.filter(m => m.senderId !== currentUserId && m.messageType !== 'system' && !m.id.startsWith('temp-'));
    firstUnread.current = fromOthers[Math.max(0, fromOthers.length - unreadAtOpen.current)]?.id ?? null;
  }
  const firstUnreadId = firstUnread.current;

  const scrollToBottom = (smooth: boolean) => {
    const container = scrollContainerRef.current;
    container?.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewBelow(0);
  };

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;

    // Older messages were prepended: keep the same messages in view
    if (container && scrollHeightBeforePrepend.current !== null) {
      container.scrollTop = container.scrollHeight - scrollHeightBeforePrepend.current;
      scrollHeightBeforePrepend.current = null;
      return;
    }

    const last = messages[messages.length - 1];
    if (!container || !last || last.id === lastRenderedMessageId.current) {
      lastRenderedMessageId.current = last?.id;
      return;
    }
    if (lastRenderedMessageId.current === undefined) {
      // Just opened: at the "New messages" line if there's one, else at the newest message. No animation.
      const line = firstUnreadId ? container.querySelector<HTMLElement>('[data-unread-line]') : null;
      const lineTop = line ? line.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop : 0;
      container.scrollTop = line ? Math.max(0, lineTop - container.clientHeight / 4) : container.scrollHeight;
      nearBottom.current = !line;
    } else if (nearBottom.current || last.senderId === currentUserId) {
      // Reading the newest messages, or we sent it: follow along
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } else {
      // Reading older messages: don't pull them away, count it on the "new messages" button
      setNewBelow(n => n + 1);
    }
    lastRenderedMessageId.current = last.id;
  }, [messages, firstUnreadId, currentUserId]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    nearBottom.current = distance < 120;
    if (nearBottom.current && newBelow) setNewBelow(0);
    setFarFromBottom(distance > container.clientHeight);
  };

  // Reset per-conversation state
  useEffect(() => {
    lastMarkedMessageId.current = undefined;
    lastRenderedMessageId.current = undefined;
    nearBottom.current = true;
    dispatch(forgetUnreadWhenOpened(conversationId)); // captured for this visit already
    setNewBelow(0);
    setFarFromBottom(false);

    setReplyingTo(null);
    setEditingMessage(null);
    setShowInfo(false);
    setAddingExpense(false);
  }, [conversationId]);

  // Send a read receipt for the newest message from others while the chat is visible
  useEffect(() => {
    const latestFromOthers = [...messages]
      .reverse()
      .find(m => m.senderId !== currentUserId && !m.id.startsWith('temp-'));

    if (!latestFromOthers || !isConnected) return;

    const markIfVisible = () => {
      if (
        document.visibilityState !== 'visible' ||
        lastMarkedMessageId.current === latestFromOthers.id
      ) {
        return;
      }
      lastMarkedMessageId.current = latestFromOthers.id;
      markAsRead(latestFromOthers.id);
      dispatch(clearUnreadCount(conversationId));
    };

    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [messages, currentUserId, markAsRead, isConnected, conversationId, dispatch]);

  const handleLoadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    scrollHeightBeforePrepend.current = scrollContainerRef.current?.scrollHeight ?? null;
    try {
      await dispatch(fetchOlderMessages(conversationId));
    } finally {
      setLoadingOlder(false);
      // If nothing was prepended, don't let the saved height affect the next update
      requestAnimationFrame(() => { scrollHeightBeforePrepend.current = null; });
    }
  };

  // Handle send message (or save an edit)
  const handleSendMessage = async (text: string, attachments?: OutgoingAttachment[]) => {
    if (editingMessage) {
      const original = editingMessage;
      setEditingMessage(null);
      if (text === original.text) return;
      if (!text && !original.mediaUrl) {
        toast.error("Message can't be empty. Delete it instead.");
        return;
      }
      try {
        if (original.e2eVersion === 2) {
          // v2: the edit is a new encrypted packet to the same devices; the server row doesn't change
          await editV2({ conversationId, isGroup: !!isGroup, members: conversationMembers }, original, text);
          dispatch(applyMessageUpdate({ conversationId, messageId: original.id, text, editedAt: new Date().toISOString() }));
          return;
        }
        // Encrypted chat (v1): the edit is a new envelope (keeping the attached file's key)
        const sealed = await sealFor(conversationId, { t: text, m: mediaPayloadOf(original) });
        const result = await chatService.editMessage(original.id, sealed?.text ?? text, sealed?.hasLink);
        dispatch(applyMessageUpdate({
          conversationId,
          messageId: original.id,
          text,
          editedAt: result.data?.editedAt ?? new Date().toISOString(),
        }));
      } catch (error) {
        toast.error(`Couldn't edit message: ${parseApiError(error)}`);
      }
      return;
    }

    if (!text.trim() && !attachments?.length) return;

    // Stop typing indicator
    stopTyping();

    if (attachments?.length) {
      // One message per photo/file, each with its own caption (the reply goes on the first)
      attachments.forEach((a, i) => {
        sendMessage(conversationId, a.caption, a.file, i === 0 ? replyingTo : null, { quality: a.quality });
      });
    } else {
      sendMessage(conversationId, text, undefined, replyingTo);
    }
    setReplyingTo(null);
  };

  const handleSendVoice = (file: File, seconds: number) => {
    stopTyping();
    sendMessage(conversationId, '', file, replyingTo, { quality: 'original', duration: seconds });
    setReplyingTo(null);
  };

  const handleDownload = (message: Message) => {
    if (!message.mediaUrl) return;
    (message.mediaKey
      ? downloadDecrypted(message.mediaUrl, message.mediaKey, message.mediaMime, message.mediaFilename || 'download', message.mediaV2)
      : downloadMedia(message.mediaUrl, message.mediaFilename || 'download'))
      .catch(() => toast.error("Couldn't download it. Try again"));
  };

  const handleReply = (message: Message) => {
    setEditingMessage(null);
    setReplyingTo({
      id: message.id,
      text: messagePreview(message.text, message.mediaType, message.mediaFilename),
      senderId: message.senderId,
      senderName: message.senderId === currentUserId ? 'yourself' : message.senderName,
      messageType: message.messageType,
    });
  };

  const handleEdit = (message: Message) => {
    setReplyingTo(null);
    setEditingMessage(message);
  };

  const handleReact = async (message: Message, emoji: string) => {
    try {
      await chatService.reactToMessage(message.id, emoji);
    } catch (error) {
      toast.error(`Couldn't react: ${parseApiError(error)}`);
    }
  };

  const handleDelete = async (message: Message) => {
    if (!(await confirmDialog({ title: 'Delete this message for everyone?', confirmText: 'Delete', danger: true }))) return;
    try {
      await chatService.deleteMessage(message.id);
      dispatch(applyMessageUpdate({ conversationId, messageId: message.id, isDeleted: true }));
      if (editingMessage?.id === message.id) setEditingMessage(null);
    } catch (error) {
      toast.error(`Couldn't delete message: ${parseApiError(error)}`);
    }
  };

  // Single messages and photo albums, in display order
  const chatItems = useMemo(() => groupAlbums(messages), [messages]);

  // Photos in this chat, for the full-screen viewer
  const viewerImages: ViewerImage[] = useMemo(
    () => messages
      .filter(m => m.mediaType === 'image' && m.mediaUrl && !m.isDeleted)
      .map(m => ({
        id: m.id,
        url: resolveMediaUrl(m.mediaUrl)!,
        mediaKey: m.mediaKey,
        mediaMime: m.mediaMime,
        mediaV2: m.mediaV2,
        filename: m.mediaFilename,
        senderName: m.senderId === currentUserId ? 'You' : m.senderName,
        timestamp: m.timestamp,
      })),
    [messages, currentUserId]
  );

  const openImage = (messageId: string) => {
    const index = viewerImages.findIndex(image => image.id === messageId);
    if (index !== -1) setViewerIndex(index);
  };

  // Media links are signed and expire after a day or two: reload the messages for fresh links
  const refreshExpiredMedia = useCallback(() => {
    if (Date.now() - lastMediaRefresh.current < 60_000) return;
    lastMediaRefresh.current = Date.now();
    dispatch(fetchMessages(conversationId));
  }, [dispatch, conversationId]);

  // Opened from a search result (?msg=<id>): load older pages until the message is there, then show it
  const searchTarget = searchParams.get('msg');
  const hasMoreRef = useRef(hasMoreMessages);
  hasMoreRef.current = hasMoreMessages;
  useEffect(() => {
    if (!searchTarget) return;
    let cancelled = false;
    const found = () => !!scrollContainerRef.current?.querySelector(`[data-message-id="${searchTarget}"]`);
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    (async () => {
      await wait(400); // first page
      for (let page = 0; page < 40 && !cancelled && !found(); page++) {
        if (!hasMoreRef.current) break;
        await dispatch(fetchOlderMessages(conversationId));
        await wait(150);
      }
      if (cancelled) return;
      jumpToMessage(searchTarget, "Couldn't find that message in this chat any more.");
      const next = new URLSearchParams(searchParams);
      next.delete('msg');
      setSearchParams(next, { replace: true });
    })();
    return () => { cancelled = true; };
  }, [searchTarget, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to (and briefly highlight) the message a reply quotes
  const jumpToMessage = (messageId: string, notFound = 'Load older messages to see the original.') => {
    const container = scrollContainerRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!container || !target) {
      toast.info(notFound);
      return;
    }
    const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + offset - container.clientHeight / 3, behavior: 'smooth' });
    target.classList.add('message-highlight');
    window.setTimeout(() => target.classList.remove('message-highlight'), 1600);
  };

  // Handle typing
  const handleTyping = (isTyping: boolean) => {
    if (isTyping) {
      startTyping();
    } else {
      stopTyping();
    }
  };

  const renderMessage = (message: Message) => message.messageType === 'system' && message.expenseId ? (
              <div key={message.id} data-message-id={message.id}>
                <ExpenseCard
                  expenseId={message.expenseId}
                  text={message.text}
                  timestamp={message.timestamp}
                  currentUserId={currentUserId}
                  onOpen={(id) => setSearchParams({ expense: id })}
                />
              </div>
            ) : message.messageType === 'system' ? (
              <div key={message.id} data-message-id={message.id} className="flex justify-center">
                <span className="px-3 py-1 text-xs text-muted-600 bg-muted-100 rounded-full text-center">
                  {message.text}
                </span>
              </div>
            ) : (
              <MessageBubble
                key={message.id}
                id={message.id}
                text={message.text}
                timestamp={message.timestamp}
                isSent={message.senderId === currentUserId}
                senderName={message.senderName}
                senderAvatar={message.senderAvatar}
                status={message.status}
                mediaUrl={resolveMediaUrl(message.mediaUrl)}
                mediaType={message.mediaType}
                mediaFilename={message.mediaFilename}
                mediaSize={message.mediaSize}
                mediaThumbnail={resolveMediaUrl(message.mediaThumbnail)}
                mediaWidth={message.mediaWidth}
                mediaHeight={message.mediaHeight}
                mediaKey={message.mediaKey}
                mediaMime={message.mediaMime}
                thumbKey={message.thumbKey}
                e2e={message.e2e}
                mediaV2={message.mediaV2}
                thumbV2={message.thumbV2}
                mediaBlur={message.mediaBlur}
                e2eUnverified={message.e2eUnverified}
                uploadProgress={message.uploadProgress}
                isGroup={isGroup}
                isDeleted={message.isDeleted}
                editedAt={message.editedAt}
                replyTo={message.replyTo}
                reactions={message.reactions}
                currentUserId={currentUserId}
                onReply={() => handleReply(message)}
                onReact={(emoji) => handleReact(message, emoji)}
                onEdit={() => handleEdit(message)}
                onDelete={() => handleDelete(message)}
                onJumpToMessage={jumpToMessage}
                onOpenImage={() => openImage(message.id)}
                onMediaError={message.id.startsWith('temp-') ? undefined : refreshExpiredMedia}
                mediaDuration={message.mediaDuration}
                uploadFailed={message.uploadFailed}
                onCancelUpload={message.id.startsWith('temp-') ? () => dispatch(cancelUpload(conversationId, message.id)) : undefined}
                onRetryUpload={() => dispatch(retryUpload(message.id))}
                onRetrySend={() => dispatch(retryText(conversationId, message.id, currentUserId))}
                onDiscard={() => dispatch(discardFailed(conversationId, message.id))}
                onForward={() => setForwarding(message)}
                onReport={() => setReporting({
                  title: 'Report this message', messageId: message.id, conversationId,
                  userId: message.senderId, userName: message.senderName || 'this person',
                  messageText: message.text || undefined,
                })}
                onDownload={message.mediaUrl ? () => handleDownload(message) : undefined}
              />
            );

  return (
    <div className="relative flex flex-col h-full min-w-0 bg-[#f6f6f8]">
      {/* Header */}
      <div className="flex items-center gap-3 sm:gap-4 px-3 sm:px-6 min-h-[72px] py-3 border-b border-muted-200 bg-white">
        {/* Back button (mobile) */}
        {onBack && (
          <button
            onClick={onBack}
            className="md:hidden p-2 hover:bg-muted-100 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5 text-muted-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        {/* Avatar + name open the info panel */}
        <button
          type="button"
          onClick={() => setShowInfo(true)}
          className="flex-shrink-0 rounded-full"
          title={isGroup ? 'Group info' : 'Contact info'}
        >
          <Avatar
            src={conversationAvatar}
            alt={conversationName}
            size="md"
            online={isOnline}
            group={isGroup}
          />
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setShowInfo(true)}>
          <h2 className="flex items-center gap-1.5 font-display text-[17px] font-bold text-muted-900 min-w-0">
            <span className="truncate">{conversationName}</span>
            {encryption.state === 'encrypted' && (
              <span title="End-to-end encrypted: only the people in this chat can read its messages" aria-label="End-to-end encrypted">
                <Lock className="w-3.5 h-3.5 text-muted-400 flex-shrink-0" />
              </span>
            )}
          </h2>

          {/* Status */}
          {isTyping ? (
            <p className="text-xs text-success-700 font-medium">
              {isGroup ? typingText : 'Typing...'}
            </p>
          ) : (
            <p className="text-xs text-muted-500">
              {isGroup
                ? `${memberCount || 0} member${memberCount === 1 ? '' : 's'}`
                : isOnline ? 'Online' : 'Offline'}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {/* Connection status indicator */}
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-success-500' : 'bg-muted-300'}`}
            title={isConnected ? 'Connected' : 'Disconnected'}
          />

          {isGroup && (
            <button
              type="button"
              onClick={() => { setInfoAddMembers(true); setShowInfo(true); }}
              className="p-2 hover:bg-primary-50 rounded-lg transition-colors"
              title="Add members"
              aria-label="Add members"
            >
              <UserPlus className="w-5 h-5 text-primary-700" strokeWidth={1.75} />
            </button>
          )}
          <button
            onClick={() => setSearching((v) => !v)}
            className={`p-2 rounded-lg transition-colors ${searching ? 'bg-primary-50 text-primary-700' : 'hover:bg-muted-100 text-muted-600'}`}
            title="Search in this chat"
            aria-label="Search in this chat"
            aria-expanded={searching}
          >
            <Search className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowInfo(true)}
            className="p-2 hover:bg-muted-100 rounded-lg transition-colors"
            title={isGroup ? 'Group info' : 'Contact info'}
            aria-label={isGroup ? 'Group info' : 'Contact info'}
          >
            <svg className="w-5 h-5 text-muted-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
        </div>
      </div>

      {searching && (
        <ChatSearch
          conversationId={conversationId}
          currentUserId={currentUserId}
          onPick={(id) => {
            const next = new URLSearchParams(searchParams);
            next.set('msg', id);
            setSearchParams(next, { replace: true });
          }}
          onClose={() => setSearching(false)}
        />
      )}

      {/* Someone's security code changed (they started fresh): say so once; verified contacts must be accepted */}
      {keyChanges.map((t) => {
        const name = isGroup ? (messages.find((m) => m.senderId === t.user)?.senderName || 'A member') : conversationName;
        return (
          <div key={t.user} className={`flex items-start gap-2 px-4 sm:px-6 py-2 text-xs border-b ${t.needsAccept ? 'bg-accent-50 text-accent-800 border-accent-100' : 'bg-primary-50 text-primary-900 border-primary-100'}`} role="status">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span className="flex-1">
              {t.needsAccept
                ? `${name}'s security code changed. You'd verified them, so messages to them wait until you check the new code or accept it.`
                : `${name}'s security code changed, probably because they started fresh on a new device.`}
            </span>
            <button type="button" onClick={() => setShowInfo(true)} className="font-semibold hover:underline">Compare codes</button>
            <button type="button" onClick={() => (t.needsAccept ? trustActions.accept(t.user) : trustActions.dismiss(t.user))} className="font-semibold hover:underline">
              {t.needsAccept ? 'Accept' : 'OK'}
            </button>
          </div>
        );
      })}

      {/* Not end-to-end encrypted yet: say why */}
      {encryption.state === 'not-encrypted' && (
        <div className="flex items-start gap-2 px-4 sm:px-6 py-2 text-xs bg-warning-50 text-warning-800 border-b border-warning-100">
          <LockOpen className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            {isGroup
              ? `Not end-to-end encrypted yet: ${encryption.missing.length} member${encryption.missing.length === 1 ? " hasn't" : "s haven't"} set up encryption. New messages will be encrypted once everyone has.`
              : `Not end-to-end encrypted yet: ${conversationName} hasn't set up encryption. New messages will be encrypted once they do.`}
          </span>
        </div>
      )}

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-label={`Messages with ${conversationName}`}
        aria-live="polite"
        aria-relevant="additions"
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 md:px-6 pt-6 pb-4 space-y-4"
      >
        {hasMoreMessages && (
          <div className="flex justify-center">
            <button
              onClick={handleLoadOlder}
              disabled={loadingOlder}
              className="px-4 py-1.5 text-sm text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-full transition-colors disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-400">No messages yet. Say hello.</p>
          </div>
        ) : (
          <>
            {chatItems.map((item) => {
              const ids = item.kind === 'album' ? item.messages.map(m => m.id) : [item.message.id];
              const line = firstUnreadId && ids.includes(firstUnreadId) ? (
                <div key={`unread-${firstUnreadId}`} data-unread-line role="separator" aria-label="New messages"
                  className="flex items-center gap-3 text-xs font-bold uppercase tracking-wide text-primary-600">
                  <span className="h-px flex-1 bg-primary-200" />New messages<span className="h-px flex-1 bg-primary-200" />
                </div>
              ) : null;
              return <React.Fragment key={ids[0]}>{line}{item.kind === 'album' ? (
              <AlbumGrid
                key={item.messages[0].id}
                messages={item.messages}
                isSent={item.messages[0].senderId === currentUserId}
                isGroup={isGroup}
                onOpen={openImage}
                onMediaError={refreshExpiredMedia}
              />
            ) : renderMessage(item.message)}</React.Fragment>;
            })}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Newer messages below while reading further up: one tap back to the newest */}
      {(newBelow > 0 || farFromBottom) && (
        <div className="relative">
          <button type="button" onClick={() => scrollToBottom(true)}
            aria-label={newBelow > 0 ? `${newBelow} new message${newBelow === 1 ? '' : 's'}, jump to the newest` : 'Jump to the newest message'}
            className="absolute -top-14 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-white border border-muted-200 shadow-elevated text-sm font-semibold text-primary-700 hover:bg-primary-50">
            <ChevronDown className="w-4 h-4" />
            {newBelow > 0 ? `${newBelow} new message${newBelow === 1 ? '' : 's'}` : 'Newest'}
          </button>
        </div>
      )}

      {/* Typing Indicator */}
      {isTyping && (
        <div className="px-6 py-2 text-sm text-muted-500">
          {typingText}
          <span className="inline-flex gap-1 ml-2">
            <span className="w-2 h-2 bg-muted-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
            <span className="w-2 h-2 bg-muted-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
            <span className="w-2 h-2 bg-muted-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
          </span>
        </div>
      )}

      {/* Message Input (or why there isn't one) */}
      {blockedUserId ? (
        <div className="border-t border-muted-200 bg-white px-4 py-4 mobile-nav-safe flex flex-wrap items-center justify-center gap-3 text-sm text-muted-600">
          You blocked {conversationName}. You can't message each other.
          <button type="button" onClick={unblock} disabled={unblocking}
            className="px-3 py-1.5 rounded-lg font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 disabled:opacity-50">
            {unblocking ? 'Unblocking…' : 'Unblock'}
          </button>
        </div>
      ) : (
      <div className="border-t border-muted-200 bg-white px-3 sm:px-5 py-2.5 mobile-nav-safe">
        <MessageInput
          key={conversationId}
          draftKey={conversationId}
          onSend={handleSendMessage}
          onSendVoice={handleSendVoice}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          editingText={editingMessage ? editingMessage.text : null}
          onCancelEdit={() => setEditingMessage(null)}
          onTyping={handleTyping}
          placeholder={isConnected ? "Type a message..." : "Waiting for connection…"}
          disabled={!isConnected}
          showExpense
          onExpense={() => setAddingExpense(true)}
        />
      </div>
      )}

      {viewerIndex !== null && (
        <MediaViewer
          images={viewerImages}
          onForward={(id) => {
            const target = messages.find(m => m.id === id);
            if (target) setForwarding(target);
          }}
          index={Math.min(viewerIndex, viewerImages.length - 1)}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}

      {(addingExpense || openReceiptId) && (
        <AddExpenseSheet
          conversationId={conversationId}
          currentUserId={currentUserId}
          receiptId={openReceiptId || undefined}
          onClose={() => { setAddingExpense(false); if (openReceiptId) closeExpenseView(); }}
        />
      )}
      {forwarding && (
        <ForwardDialog
          message={forwarding}
          onSend={(ids) => dispatch(forwardMessage(forwarding, ids))}
          onClose={() => setForwarding(null)}
        />
      )}
      {openExpenseId && (
        <ExpenseDetail expenseId={openExpenseId} currentUserId={currentUserId} onClose={closeExpenseView} />
      )}

      {reporting && <ReportDialog target={reporting} onClose={() => setReporting(null)} />}

      <ConversationInfoPanel
        conversationId={conversationId}
        isOpen={showInfo}
        startAddingMembers={infoAddMembers}
        onClose={() => { setShowInfo(false); setInfoAddMembers(false); }}
      />
    </div>
  );
};

export default ChatWindow;