// src/redux/actions/websocketActions.ts - NO AUTH DEPENDENCY

import type { AppDispatch, RootState } from '../store';
import { wsService } from '../../services/websocket.service';
import {
  setConnecting,
  setConnected,
  setError,
  addOnlineUser,
  removeOnlineUser,
  setOnlineUsers,
  setTyping,
  resetWebSocket
} from '../slices/websocketSlice';
import {
  addMessage,
  updateMessage,
  upsertMessage,
  removeMessage,
  applyMessageUpdate,
  setReactions,
  setPinned,
  setConversationPrefs,
  markMessagesRead,
  markMessagesDelivered,
  setBlocked,
  syncOnlineStatus,
  setActiveConversation,
  updateUserOnlineStatus,
  updateConversationLastMessage,
  incrementUnreadCount,
} from '../slices/chatSlice';
import type { Message, ReplyPreview } from '../slices/chatSlice';
import { toast } from 'react-toastify';
import { v2Runtime } from '../../crypto/v2-platform/runtime';
import { ACCOUNT_DELETED_EVENT, ACCOUNT_SUSPENDED_EVENT, LOGGED_OUT_ELSEWHERE_EVENT } from '../../utils/authRefresh';
import { mediaService } from '../../services/media.service';
import type { OutgoingMedia } from '../../services/websocket.service';
import { captureVideoPoster, compressImage, measureMedia, mediaTypeOf, messagePreview } from '../../utils/media';
import { decryptedFields, decryptMessage, openText, NOT_ENCRYPTED_TEXT, recipientsFor, sealFor } from '../../crypto/messages';
import { e2eSession } from '../../crypto/session';
import { encryptForUpload, rememberDecrypted } from '../../crypto/media';
import type { E2EMedia } from '../../crypto/e2e';
import { e2eService } from '../../services/e2e.service';
import { E2E_DIRECTORY_EVENT } from '../../crypto/useChatEncryption';
import {
  answerRetry, answerWaitingRetries, askAgain, confirmOwn, drainMailbox, forgetDirectory, forwardV2, fromLocal, isV2Marker, localFor,
  myDeviceId, pendingFields, pointerOf, receiveLive, resendAfterDevicesChanged, sendMediaV2, sendTextV2, v2For,
} from '../../crypto/v2-platform/chat';
import type { ChatInfo, RetryRequest } from '../../crypto/v2-platform/chat';
import type { EnvelopeMeta, LocalMessage, Received } from '../../crypto/v2';
import type { UploadQuality } from '../../utils/media';
import { parseApiError } from '../../utils/apiError';

import { fetchConversations, fetchMessages, flagUnverified } from './chatActions';
import { NAVIGATE_EVENT, CONVERSATION_UPDATED_EVENT, EXPENSE_CHANGED_EVENT, RECEIPT_PROGRESS_EVENT, RECEIPT_READY_EVENT } from '../../utils/events';
import { notifyNewMessage } from '../../utils/notifications';

// import { clearUnreadCount } from '../slices/chatSlice';

let listenersInitialized = false;

export { NAVIGATE_EVENT, CONVERSATION_UPDATED_EVENT };

// clientId -> object URL of a local attachment preview, revoked once the server echoes the message
const pendingPreviews = new Map<string, string>();

// Clients repeat "typing" every few seconds while typing; if that stops (closed tab,
// lost connection) the indicator clears itself.
const TYPING_TIMEOUT_MS = 6000;
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setTypingWithExpiry(
  dispatch: AppDispatch,
  conversationId: string,
  userId: string,
  isTyping: boolean,
  userName?: string | null
) {
  const key = `${conversationId}:${userId}`;
  clearTimeout(typingTimers.get(key));
  typingTimers.delete(key);
  dispatch(setTyping({ conversationId, userId, isTyping, userName }));
  if (isTyping) {
    typingTimers.set(key, setTimeout(() => {
      typingTimers.delete(key);
      dispatch(setTyping({ conversationId, userId, isTyping: false }));
    }, TYPING_TIMEOUT_MS));
  }
}

/** Show what v2 decrypted: fill the timeline row (or edit), update the chat list, notify. */
function applyV2(dispatch: AppDispatch, getState: () => RootState, r: Received) {
  if (r.kind !== 'message' && r.kind !== 'edit') return;
  const m: LocalMessage = r.message;
  const list = getState().chat.messages[m.conv] || [];
  const row = list.find(x => (m.serverId && x.id === m.serverId) || x.localId === m.id);
  if (row) dispatch(updateMessage({ conversationId: m.conv, messageId: row.id, updates: fromLocal(m) }));
  if (r.kind !== 'message') return;
  const fields = fromLocal(m);
  dispatch(updateConversationLastMessage({
    conversationId: m.conv,
    lastMessage: messagePreview(fields.text, fields.mediaType, fields.mediaFilename),
    timestamp: new Date(m.ts).toISOString(),
  }));
  if (m.sender.user !== localStorage.getItem('userId')) {
    const conversation = getState().chat.conversations.find(c => c.id === m.conv);
    const sender = row?.senderName || 'Someone';
    const preview = messagePreview(fields.text, fields.mediaType, fields.mediaFilename);
    notifyNewMessage({
      conversationId: m.conv,
      title: conversation?.name || sender,
      body: conversation?.isGroup ? `${sender}: ${preview}` : preview,
      icon: conversation?.isGroup ? conversation.avatar : row?.senderAvatar,
    });
  }
}

/** Process this browser's v2 mailbox (after connecting). */
export const syncV2 = () => async (dispatch: AppDispatch, getState: () => RootState) => {
  await drainMailbox((r) => applyV2(dispatch, getState, r)).catch(() => undefined);
  await answerWaitingRetries().catch(() => undefined); // devices that asked for one of our messages again
};

// ---------------------------------------------------------------- envelope-first (protocol 3)
// An encrypted message enters the chat only once this browser has decrypted its own packet, which
// carries the message's details (`meta`), as on Signal and WhatsApp: never a blank bubble first.
// A packet that can't be read yet shows "Waiting for this message…" only after a grace period; one
// that can't be read at all asks the sender's device to encrypt it again.

const WAITING_GRACE_MS = 4000;

/**
 * The latest delivered / read receipts per chat. Our encrypted messages can enter the chat after their
 * receipts (another device of ours decrypts its copy a moment later than the other person reads it):
 * their ticks start from what's already known.
 */
const receiptsUpTo = new Map<string, { delivered?: number; read?: number }>();

function noteReceipt(roomId: string, kind: 'delivered' | 'read', upTo: string) {
  const at = new Date(upTo).getTime();
  const known = receiptsUpTo.get(roomId) || {};
  if (!(known[kind]! >= at)) receiptsUpTo.set(roomId, { ...known, [kind]: at });
}

/** Status of our own message sent at `timestamp`, from the receipts that already came. */
function ownStatus(roomId: string, timestamp: string, fallback: Message['status']): Message['status'] {
  const known = receiptsUpTo.get(roomId);
  const at = new Date(timestamp).getTime();
  if (known?.read !== undefined && known.read >= at) return 'read';
  if (known?.delivered !== undefined && known.delivered >= at) return 'delivered';
  return fallback;
}
/** Packets waiting for a group key (or the network): their details, to show them once they're read. */
const waitingMeta = new Map<string, EnvelopeMeta>();

const metaEvent = (meta: EnvelopeMeta) => ({ ...meta, text: 'e2e2:', status: 'sent' });

const hasRow = (getState: () => RootState, roomId: string, messageId: string) =>
  (getState().chat.messages[roomId] || []).some(m => m.id === messageId);

function showEnvelope(dispatch: AppDispatch, getState: () => RootState, r: Received, meta: EnvelopeMeta) {
  switch (r.kind) {
    case 'message':
      waitingMeta.delete(meta.messageId);
      showTimelineMessage(dispatch, metaEvent(meta), r.message);
      return;
    case 'duplicate':
      // Another tab of this browser read it first (they share the local database)
      if (r.message && !hasRow(getState, meta.roomId, meta.messageId)) showTimelineMessage(dispatch, metaEvent(meta), r.message, false);
      return;
    case 'waiting':
      waitingMeta.set(meta.messageId, meta);
      setTimeout(() => {
        if (waitingMeta.has(meta.messageId) && !hasRow(getState, meta.roomId, meta.messageId)) showTimelineMessage(dispatch, metaEvent(meta), null);
      }, WAITING_GRACE_MS);
      return;
    case 'failed':
      showTimelineMessage(dispatch, metaEvent(meta), null);
      askAgain(meta.messageId, meta.fromDevice).catch(() => undefined);
      return;
    default:
      applyV2(dispatch, getState, r);
  }
}

/** A packet that had to wait can be read now: show it if it never made it into the chat. */
function showLater(dispatch: AppDispatch, getState: () => RootState, r: Received) {
  const meta = r.kind === 'message' && r.message.serverId ? waitingMeta.get(r.message.serverId) : undefined;
  if (meta && !hasRow(getState, meta.roomId, meta.messageId)) showEnvelope(dispatch, getState, r, meta);
  else applyV2(dispatch, getState, r);
  if (meta) waitingMeta.delete(meta.messageId);
}

/** Who is in a conversation (for encryption v2), from the chat list. */
export function chatInfo(getState: () => RootState, conversationId: string): ChatInfo {
  const c = getState().chat.conversations.find(x => x.id === conversationId);
  return { conversationId, isGroup: !!c?.isGroup, members: c?.members || [] };
}

const newClientId = () =>
  `temp-${typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/**
 * Connect to WebSocket server
 */
export const connectWebSocket = (token: string) => async (dispatch: AppDispatch) => {
  try {
    dispatch(setConnecting(true));

    // Connect to WebSocket
    await wsService.connect(token);

    dispatch(setConnected(true));

    // Setup event listeners
    setupWebSocketListeners(dispatch);

    

  } catch (error) {
    console.error('❌ WebSocket connection failed:', error);
    dispatch(setError(error instanceof Error ? error.message : 'Connection failed'));
    dispatch(setConnected(false));
  } finally {
    dispatch(setConnecting(false));
  }

};

/**
 * Disconnect from WebSocket server
 */
export const disconnectWebSocket = () => (dispatch: AppDispatch) => {
  wsService.disconnect();
  dispatch(resetWebSocket());
};

/**
 * Join a conversation
 */
export const joinConversation = (conversationId: string) => (dispatch: AppDispatch) => {
  if (!wsService.isConnected()) {
    console.warn('⚠️ WebSocket not connected, cannot join conversation');
    return;
  }

  wsService.joinConversation(conversationId);
  dispatch(setActiveConversation(conversationId));
};

/**
 * Leave a conversation
 */
export const leaveConversation = (conversationId: string) => (dispatch: AppDispatch) => {
  if (!wsService.isConnected()) {
    return;
  }

  wsService.leaveConversation(conversationId);
};

/** What the composer can send with a message. */
export interface SendOptions {
  quality?: UploadQuality; // photos/videos: standard (default) or hd; original = as a document
  duration?: number; // voice notes: seconds recorded
}

// Uploads in progress or failed, by clientId, so they can be cancelled or retried
const uploads = new Map<string, {
  conversationId: string;
  text: string;
  file: File;
  replyTo?: ReplyPreview | null;
  options: SendOptions;
  controller?: AbortController;
}>();

/**
 * Send a message, optionally with an attachment.
 *
 * The message is shown immediately with a temporary id (its clientId). The
 * server echoes the clientId back, which is how the optimistic copy is replaced.
 * Attachments are uploaded to the ShareEven server first, then sent by URL.
 * An upload can be cancelled while running and retried if it fails.
 */
export const sendMessage = (
  conversationId: string,
  text: string,
  currentUserId: string,
  file?: File,
  replyTo?: ReplyPreview | null,
  options: SendOptions = {},
) => async (dispatch: AppDispatch, getState: () => RootState) => {
  if (!wsService.isConnected()) {
    console.error('❌ Cannot send message: WebSocket not connected');
    toast.error('Not connected. Please wait a moment and try again.');
    return;
  }

  const username = localStorage.getItem('username') || 'You';
  const avatar = localStorage.getItem('userAvatar') || undefined;

  const clientId = newClientId();
  const asDocument = options.quality === 'original' && file && mediaTypeOf(file) !== 'audio';
  const previewUrl = file ? URL.createObjectURL(file) : undefined;

  dispatch(addMessage({
    conversationId,
    message: {
      id: clientId,
      clientId,
      conversationId,
      senderId: currentUserId,
      senderName: username,
      senderAvatar: avatar,
      text,
      timestamp: new Date().toISOString(),
      status: 'sending',
      mediaUrl: previewUrl,
      mediaType: file ? (asDocument ? 'file' : mediaTypeOf(file)) : undefined,
      mediaSize: file?.size,
      mediaFilename: file?.name,
      mediaDuration: options.duration,
      uploadProgress: file ? 0 : undefined,
      replyTo: replyTo || null,
    }
  }));

  if (!file) {
    // Encryption v2 when everyone in the chat has it set up; otherwise v1 (or plain) as before
    const chat = chatInfo(getState, conversationId);
    const v2 = await v2For(chat).catch(() => null);
    if (v2) {
      dispatch(updateMessage({ conversationId, messageId: clientId, updates: { e2eVersion: 2, localId: clientId } }));
      try {
        if (!(await sendTextV2(v2, chat, clientId, text, replyTo))) throw new Error('Message not sent: connection lost.');
      } catch (error) {
        dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed' } }));
        toast.error(parseApiError(error));
      }
      return;
    }
    let outgoing: { text: string; hasLink: boolean };
    try {
      const sealed = await sealFor(conversationId, { t: text });
      if (!sealed) throw new Error(NOT_ENCRYPTED_TEXT);
      outgoing = sealed;
    } catch (error) {
      dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed' } }));
      toast.error(parseApiError(error));
      return;
    }
    if (!wsService.sendMessage(conversationId, clientId, outgoing.text, undefined, replyTo?.id, outgoing.hasLink)) {
      dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed' } }));
      toast.error('Message not sent: connection lost.');
    }
    return;
  }

  pendingPreviews.set(clientId, previewUrl!);
  uploads.set(clientId, { conversationId, text, file, replyTo, options });
  await dispatch(uploadAndSend(clientId));
};

const uploadAndSend = (clientId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
  const job = uploads.get(clientId);
  if (!job) return;
  const { conversationId, text, file, replyTo, options } = job;
  const quality = options.quality || 'standard';
  const kind = quality === 'original' && mediaTypeOf(file) !== 'audio' ? 'file' : mediaTypeOf(file);
  const controller = new AbortController();
  job.controller = controller;

  dispatch(updateMessage({
    conversationId,
    messageId: clientId,
    updates: { status: 'sending', uploadFailed: undefined, uploadProgress: 0 },
  }));

  // Size (to reserve space in the bubble), best-effort. Video posters are made by the server.
  const dimensionsPromise = kind === 'image' || kind === 'video'
    ? measureMedia(file).then(dims => {
        if (dims) {
          dispatch(updateMessage({ conversationId, messageId: clientId, updates: { mediaWidth: dims.width, mediaHeight: dims.height } }));
        }
        return dims;
      })
    : Promise.resolve(null);

  // Encryption v2: the file (PMV2) and its key travel only to the chat's devices
  const chat = chatInfo(getState, conversationId);
  const v2 = await v2For(chat).catch(() => null);
  if (v2) {
    dispatch(updateMessage({ conversationId, messageId: clientId, updates: { e2eVersion: 2, localId: clientId } }));
    try {
      const sent = await sendMediaV2(v2, chat, clientId, file, text, {
        quality, duration: options.duration, replyTo, signal: controller.signal,
        onProgress: (percent) => dispatch(updateMessage({ conversationId, messageId: clientId, updates: { uploadProgress: Math.min(percent, 99) } })),
      });
      uploads.delete(clientId);
      if (!sent) {
        dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed' } }));
        toast.error('Message not sent: connection lost.');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed', uploadFailed: true, uploadProgress: undefined } }));
      toast.error(`Couldn't send ${file.name}: ${parseApiError(error)}`);
    }
    return;
  }

  let media: OutgoingMedia;
  let outgoing = { text, hasLink: false };
  try {
    const toUpload = kind === 'image' ? await compressImage(file, quality) : file;
    if (await recipientsFor(conversationId)) {
      // End-to-end encrypted chat: encrypt the file (and a video's poster) before it leaves the page.
      // The server can't compress or look at it; name, size and the key go inside the message.
      const [dims, poster] = await Promise.all([dimensionsPromise, kind === 'video' ? captureVideoPoster(file) : null]);
      const sealedFile = await encryptForUpload(toUpload);
      const uploaded = await mediaService.upload(sealedFile.file, (percent) => {
        dispatch(updateMessage({ conversationId, messageId: clientId, updates: { uploadProgress: Math.min(percent, 99) } }));
      }, { signal: controller.signal, encrypted: kind });
      let posterUrl: string | undefined;
      let posterKey: string | undefined;
      if (poster) {
        const sealedPoster = await encryptForUpload(poster);
        posterUrl = (await mediaService.upload(sealedPoster.file, undefined, { signal: controller.signal, encrypted: 'image' })).url;
        posterKey = sealedPoster.key;
        rememberDecrypted(posterUrl, posterKey, poster);
      }
      rememberDecrypted(uploaded.url, sealedFile.key, toUpload); // no need to download our own file again
      const m: E2EMedia = {
        key: sealedFile.key,
        type: kind,
        mime: toUpload.type || 'application/octet-stream',
        name: toUpload.name || file.name,
        size: toUpload.size,
        w: dims?.width,
        h: dims?.height,
        d: options.duration,
        tk: posterKey,
      };
      const sealed = await sealFor(conversationId, { t: text, m });
      if (!sealed) throw new Error("This chat isn't encrypted any more. Send the file again.");
      outgoing = sealed;
      media = { mediaUrl: uploaded.url, mediaType: kind, mediaThumbnail: posterUrl };
    } else {
      throw new Error(NOT_ENCRYPTED_TEXT); // never upload a readable file
    }
  } catch (error) {
    if (controller.signal.aborted) return; // cancelled: cancelUpload already removed it
    // Keep the bubble with Retry / Remove instead of losing what the person picked
    dispatch(updateMessage({
      conversationId,
      messageId: clientId,
      updates: { status: 'failed', uploadFailed: true, uploadProgress: undefined },
    }));
    toast.error(`Couldn't send ${file.name}: ${parseApiError(error)}`);
    return;
  }

  uploads.delete(clientId);
  if (!wsService.sendMessage(conversationId, clientId, outgoing.text, media, replyTo?.id, outgoing.hasLink)) {
    dispatch(updateMessage({ conversationId, messageId: clientId, updates: { status: 'failed' } }));
    toast.error('Message not sent: connection lost.');
  }
};

/** Stop an upload that is running (or drop a failed one) and remove its bubble. */
export const cancelUpload = (conversationId: string, clientId: string) => (dispatch: AppDispatch) => {
  uploads.get(clientId)?.controller?.abort();
  uploads.delete(clientId);
  const preview = pendingPreviews.get(clientId);
  if (preview) URL.revokeObjectURL(preview);
  pendingPreviews.delete(clientId);
  dispatch(removeMessage({ conversationId, messageId: clientId }));
};

/** Try a failed upload again with the same file, caption and settings. */
export const retryUpload = (clientId: string) => (dispatch: AppDispatch) => dispatch(uploadAndSend(clientId));

/** A text message that didn't send: send it again (it moves to the end, as a new message). */
export const retryText = (conversationId: string, clientId: string, currentUserId: string) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const failed = (getState().chat.messages[conversationId] || []).find((m) => m.id === clientId);
    if (!failed) return;
    dispatch(removeMessage({ conversationId, messageId: clientId }));
    return dispatch(sendMessage(conversationId, failed.text, currentUserId, undefined, failed.replyTo));
  };

/** Drop a text message that didn't send. */
export const discardFailed = (conversationId: string, clientId: string) => (dispatch: AppDispatch) =>
  dispatch(removeMessage({ conversationId, messageId: clientId }));

/** The encrypted-file part of a message, to put in a new envelope (forward, edit). */
export const mediaPayloadOf = (m: Message): E2EMedia | undefined =>
  m.mediaKey && m.mediaType
    ? {
        key: m.mediaKey, type: m.mediaType, mime: m.mediaMime || 'application/octet-stream', name: m.mediaFilename,
        size: m.mediaSize, w: m.mediaWidth, h: m.mediaHeight, d: m.mediaDuration, tk: m.thumbKey,
      }
    : undefined;

/**
 * Send copies of a message (text and/or media) to other chats, like WhatsApp's Forward.
 * Encrypted files are re-used as they are: only their key is sealed again for the new chat.
 */
export const forwardMessage = (message: Message, conversationIds: string[]) => async (_dispatch: AppDispatch, getState: () => RootState) => {
  const encryptedMedia = mediaPayloadOf(message);
  const plainMedia: OutgoingMedia | undefined = message.mediaUrl && message.mediaType
    ? {
        mediaUrl: message.mediaUrl, // the server drops the signature and checks it's one of ours
        mediaType: message.mediaType,
        mediaSize: message.mediaSize,
        mediaFilename: message.mediaFilename,
        mediaThumbnail: message.mediaThumbnail,
        mediaWidth: message.mediaWidth,
        mediaHeight: message.mediaHeight,
        mediaDuration: message.mediaDuration,
      }
    : undefined;
  let sent = 0;
  let skipped = 0;
  for (const conversationId of conversationIds) {
    try {
      const chat = chatInfo(getState, conversationId);
      const v2 = await v2For(chat).catch(() => null);
      const v2Pointer = pointerOf(message);
      if (v2 && (v2Pointer || !message.mediaUrl)) {
        if (await forwardV2(v2, chat, newClientId(), message.text || '', v2Pointer)) sent += 1;
        continue;
      }
      if (v2Pointer) {
        skipped += 1; // a v2 file can only go to a chat that uses v2
        continue;
      }
      const sealed = await sealFor(conversationId, { t: message.text || '', m: encryptedMedia });
      if (!sealed) {
        skipped += 1; // nothing goes to a chat that isn't end-to-end encrypted yet
        continue;
      }
      const media = encryptedMedia
        ? { mediaUrl: message.mediaUrl!, mediaType: message.mediaType!, mediaThumbnail: message.mediaThumbnail }
        : plainMedia;
      if (wsService.sendMessage(conversationId, newClientId(), sealed.text, media, undefined, sealed.hasLink)) sent += 1;
    } catch (error) {
      toast.error(parseApiError(error));
    }
  }
  if (skipped) toast.info(`Not forwarded to ${skipped === 1 ? 'a chat' : `${skipped} chats`} that isn't end-to-end encrypted yet`);
  if (sent) toast.success(sent === 1 ? 'Message forwarded' : `Forwarded to ${sent} chats`);
  else if (!skipped) toast.error('Not connected. Please try again.');
};

/**
 * Send typing indicator
 */
export const sendTyping = (conversationId: string, isTyping: boolean) => () => {
  if (!wsService.isConnected()) {
    return;
  }

  wsService.sendTyping(conversationId, isTyping);
};

/**
 * Mark message as read
 */
export const markAsRead = (conversationId: string, lastMessageId: string) => () => {
  if (!wsService.isConnected()) {
    return;
  }

  wsService.markAsRead(conversationId, lastMessageId);
};

/**
 * Put a timeline message in the chat: a `message` event (plain and version 1 chats, and version 2 from
 * a server without protocol 3), or an encrypted (v2) message with its details from its envelope.
 * `v2Local`: this browser's decrypted copy (null: couldn't be read, shown as waiting; undefined: not
 * from an envelope). `notify`: false for a copy another tab already announced.
 */
function showTimelineMessage(dispatch: AppDispatch, data: any, v2Local?: LocalMessage | null, notify = true) {
  if (!data.roomId || !data.messageId) return;
  const message = decryptMessage({
    id: data.messageId,
    clientId: data.clientId || undefined,
    conversationId: data.roomId,
    senderId: data.senderId || '',
    senderName: data.senderName,
    senderAvatar: data.senderAvatar,
    text: data.text || '',
    timestamp: data.timestamp || new Date().toISOString(),
    status: (data.status as 'sent' | 'delivered' | undefined) || 'delivered',
    mediaUrl: data.mediaUrl || undefined,
    mediaType: data.mediaType || undefined,
    mediaSize: data.mediaSize || undefined,
    mediaFilename: data.mediaFilename || undefined,
    mediaThumbnail: data.mediaThumbnail || undefined,
    mediaWidth: data.mediaWidth || undefined,
    mediaHeight: data.mediaHeight || undefined,
    mediaDuration: data.mediaDuration || undefined,
    uploadProgress: undefined,
    uploadFailed: undefined,
    messageType: data.messageType,
    expenseId: data.expenseId || null,
    replyTo: data.replyTo || null,
    reactions: [],
  } as Message);

  // Quoting a v2 message: the server only has its marker; the quoted text is in this browser's copy
  const quoted = message.replyTo;
  if (quoted && isV2Marker(quoted.text)) {
    message.replyTo = { ...quoted, text: '' };
    const quotingRoom: string = data.roomId;
    const quotingId: string = data.messageId;
    localFor(quoted.id).then(local => {
      dispatch(updateMessage({
        conversationId: quotingRoom,
        messageId: quotingId,
        updates: { replyTo: { ...quoted, text: local ? fromLocal(local).text || 'Attachment' : 'Encrypted message' } },
      }));
    }).catch(() => undefined);
  }

  const timestamp: string = data.timestamp || new Date().toISOString();
  const v2 = isV2Marker(data.text);
  // From an envelope the content is already decrypted (or known to be unreadable for now)
  const v2Fields = v2Local ? fromLocal(v2Local) : null;
  if (v2Local !== undefined && data.senderId === localStorage.getItem('userId')) {
    message.status = ownStatus(data.roomId, timestamp, message.status);
  }
  dispatch(upsertMessage({ conversationId: data.roomId, message: v2 ? { ...message, ...(v2Fields || pendingFields) } : message }));
  if (v2 && v2Local === undefined) {
    // A marker row without its packet (a server without protocol 3): the content comes in this
    // device's own packet; ours is already in the local database
    const roomId: string = data.roomId;
    const messageId: string = data.messageId;
    const clientId = data.clientId;
    const own = !!clientId && data.senderId === localStorage.getItem('userId');
    (own ? confirmOwn(clientId!, messageId) : localFor(messageId)).then(local => {
      if (!local) return;
      const fields = fromLocal(local);
      dispatch(updateMessage({ conversationId: roomId, messageId, updates: fields }));
      // Replace the "Encrypted message" placeholder in the chat list, unless a newer message came since
      dispatch((_: AppDispatch, getState: () => RootState) => {
        const conversation = getState().chat.conversations.find(c => c.id === roomId);
        if (conversation?.lastMessageTime !== timestamp) return;
        dispatch(updateConversationLastMessage({
          conversationId: roomId,
          lastMessage: messagePreview(fields.text, fields.mediaType, fields.mediaFilename),
          timestamp,
        }));
      });
    }).catch(() => undefined);
  } else if (!v2) {
    flagUnverified(dispatch, data.roomId, [message]);
  }

  // Our optimistic copy now points at the server URL; free the local preview
  if (data.clientId && pendingPreviews.has(data.clientId)) {
    URL.revokeObjectURL(pendingPreviews.get(data.clientId)!);
    pendingPreviews.delete(data.clientId);
  }

  // Update last message
  const shown = v2 ? v2Fields : message;
  dispatch(updateConversationLastMessage({
    conversationId: data.roomId,
    lastMessage: shown ? messagePreview(shown.text, shown.mediaType, shown.mediaFilename) : 'Encrypted message',
    timestamp
  }));

  const roomId = data.roomId;
  const isOwn = data.senderId === localStorage.getItem('userId');

  // Tell the sender it reached this device (their one tick becomes two)
  if (!isOwn && data.messageType !== 'system') wsService.markDelivered(roomId, data.messageId);

  // Sending a message means they stopped typing
  if (data.senderId) setTypingWithExpiry(dispatch, roomId, data.senderId, false);

  // Desktop notification for messages from others (skipped if this chat is in view). A v2 marker row
  // without its envelope notifies when its content is decrypted (applyV2).
  if (notify && !isOwn && data.messageType !== 'system' && (!v2 || v2Local !== undefined)) {
    dispatch((_: AppDispatch, getState: () => RootState) => {
      const conversation = getState().chat.conversations.find(c => c.id === roomId);
      const sender = data.senderName || 'Someone';
      const preview = !shown || message.e2e === 'unreadable' ? 'New message' : messagePreview(shown.text, shown.mediaType, shown.mediaFilename);
      notifyNewMessage({
        conversationId: roomId,
        title: conversation?.name || sender,
        body: conversation?.isGroup ? `${sender}: ${preview}` : preview,
        icon: conversation?.isGroup ? conversation.avatar : data.senderAvatar,
      });
    });
  }

  // Keep the chat list in sync locally (last message was updated above);
  // only reload it when the message is for a conversation we don't know yet
  dispatch((_: AppDispatch, getState: () => RootState) => {
    const known = getState().chat.conversations.some(c => c.id === roomId);
    if (!known) {
      dispatch(fetchConversations());
      return;
    }
    const viewing =
      (window as any).__activeConversationId === roomId && document.visibilityState === 'visible';
    if (!isOwn && !viewing && notify) {
      dispatch(incrementUnreadCount(roomId));
    }
  });
}

/**
 * Setup WebSocket event listeners
 */
function setupWebSocketListeners(dispatch: AppDispatch) {


  // getStateRef = getState;

  if (listenersInitialized) {
    return;
  }

  listenersInitialized = true;  // ✅ Mark as initialized

  // Message received (also the echo of our own messages)
  wsService.on('message', (data) => showTimelineMessage(dispatch, data));



  // Typing indicator
  wsService.on('typing', (data) => {
    if (data.roomId && data.userId) {
      setTypingWithExpiry(dispatch, data.roomId, data.userId, !!data.isTyping, data.userName);
    }
  });

  // Mute / archive changed on another of our devices
  wsService.on('conversation_prefs', (data) => {
    if (!data.conversationId) return;
    dispatch(setConversationPrefs({
      conversationId: data.conversationId,
      ...('mutedUntil' in data ? { mutedUntil: data.mutedUntil } : {}),
      ...('isArchived' in data ? { isArchived: data.isArchived } : {}),
      ...(data.isPinned === false ? { isPinned: false } : {}),
    }));
  });

  wsService.on('conversation_pinned', (data) => {
    if (data.conversationId) {
      dispatch(setPinned({ conversationId: data.conversationId, pinnedAt: data.pinned ? data.pinnedAt || new Date().toISOString() : null }));
    }
  });

  // Delivery receipt: everyone has our messages up to this time on a device
  wsService.on('delivered', (data) => {
    if (data.roomId && data.deliveredUpTo) {
      noteReceipt(data.roomId, 'delivered', data.deliveredUpTo);
      dispatch(markMessagesDelivered({ conversationId: data.roomId, deliveredUpTo: data.deliveredUpTo }));
    }
  });

  // Read receipt
  wsService.on('read', (data) => {

    // readUpTo: every member has read up to this time, so our older messages are read
    if (data.roomId && data.readUpTo) {
      noteReceipt(data.roomId, 'read', data.readUpTo);
      dispatch(markMessagesRead({
        conversationId: data.roomId,
        readUpTo: data.readUpTo
      }));
    }
  });

  // User came online
  wsService.on('online', (data) => {


    if (data.userId) {
      dispatch(addOnlineUser(data.userId));
      dispatch(updateUserOnlineStatus({ userId: data.userId, isOnline: true }));
    }
  });

  // A message was edited or deleted
  wsService.on('message_updated', (data) => {
    if (!data.roomId || !data.messageId) return;
    const roomId: string = data.roomId;
    const messageId: string = data.messageId;
    // An edited encrypted message comes as a new envelope: decrypt it with the original sender
    dispatch((_: AppDispatch, getState: () => RootState) => {
      const senderId = getState().chat.messages[roomId]?.find(m => m.id === messageId)?.senderId;
      const opened = senderId && !data.isDeleted ? openText(data.text, roomId, senderId) : null;
      if (opened) {
        dispatch(updateMessage({ conversationId: roomId, messageId, updates: { ...decryptedFields(opened), editedAt: data.editedAt } }));
      } else {
        dispatch(applyMessageUpdate({
          conversationId: roomId,
          messageId,
          text: data.text,
          editedAt: data.editedAt,
          isDeleted: data.isDeleted,
        }));
      }
    });
    dispatch(fetchConversations()); // last-message preview may have changed
  });

  wsService.on('reactions_updated', (data) => {
    if (!data.roomId || !data.messageId) return;
    dispatch(setReactions({
      conversationId: data.roomId,
      messageId: data.messageId,
      reactions: data.reactions || [],
    }));
  });

  // An expense, payment or expense setting changed in one of our chats
  wsService.on('expense_changed', (data) => {
    window.dispatchEvent(new CustomEvent(EXPENSE_CHANGED_EVENT, {
      detail: { conversationId: data.conversationId, expenseId: data.expenseId, action: data.action },
    }));
  });

  // One of our devices was logged out (Settings → Sessions): if it's this browser, sign out here
  wsService.on('session_revoked', (data) => {
    v2Runtime()?.then((r) => {
      if (r.state.deviceId === data.deviceId) window.dispatchEvent(new Event(LOGGED_OUT_ELSEWHERE_EVENT));
    }).catch(() => undefined);
  });

  // You blocked or unblocked someone (maybe on another device)
  wsService.on('block_changed', (data) => {
    if (data.userId) dispatch(setBlocked({ userId: data.userId, blocked: !!data.blocked }));
  });

  // The account was deleted from one of its devices: every device signs out and wipes itself
  wsService.on('account_deleted', () => {
    window.dispatchEvent(new Event(ACCOUNT_DELETED_EVENT));
  });

  // An app admin suspended this account
  wsService.on('account_suspended', () => {
    window.dispatchEvent(new Event(ACCOUNT_SUSPENDED_EVENT));
  });

  // Someone in a chat reminded us that we owe them
  wsService.on('expense_reminder', (data) => {
    if (typeof data.text === 'string') toast.info(data.text, { autoClose: 8000 });
  });

  // The AI moved on to the next step of reading our receipt (the scan screen shows it)
  wsService.on('receipt_scan_progress', (data) => {
    window.dispatchEvent(new CustomEvent(RECEIPT_PROGRESS_EVENT, { detail: data }));
  });

  // The AI finished reading a receipt we uploaded
  wsService.on('receipt_scan_ready', (data) => {
    window.dispatchEvent(new CustomEvent(RECEIPT_READY_EVENT, { detail: data }));
    // Already looking at it (the scan screen is open)? Then no toast.
    if ((window as any).__waitingForReceiptId === data.receiptId) return;
    const path = `/chat/${data.conversationId}?receipt=${data.receiptId}`;
    const open = () => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: path }));
    if (data.status === 'failed') {
      toast.error(`Couldn't read your receipt: ${data.error || 'try again'}`, { onClick: open });
    } else {
      toast.success('Your receipt is ready to review', { onClick: open });
    }
  });

  // Encryption v2: a packet for one of this account's devices
  wsService.on('e2e_envelope', (data) => {
    const deviceId = data.deviceId;
    const envelope = data.envelope;
    if (typeof deviceId !== 'number' || !envelope) return;
    const meta: EnvelopeMeta | undefined = data.meta;
    dispatch((_: AppDispatch, getState: () => RootState) => {
      receiveLive(deviceId, envelope, (r) => showLater(dispatch, getState, r)).then(r => {
        if (!r) return;
        // With its details (a new message): it enters the chat now. Without (edits, resends): fills a row
        if (meta) showEnvelope(dispatch, getState, r, meta);
        else applyV2(dispatch, getState, r);
      }).catch(() => undefined);
    });
  });

  // The server took one of our encrypted messages: link our copy to its timeline row
  wsService.on('message_sent', (data) => {
    const { roomId, messageId, clientId, fromDevice } = data;
    if (!roomId || !messageId || !clientId) return;
    const timestamp = data.timestamp || new Date().toISOString();
    dispatch(async (_: AppDispatch, getState: () => RootState) => {
      if (fromDevice !== (await myDeviceId())) return; // sent from another of my devices: its envelope shows it
      const local = await confirmOwn(clientId, messageId).catch(() => null);
      const fields = local ? fromLocal(local) : {};
      if (hasRow(getState, roomId, clientId)) {
        // Sent from this tab: the optimistic bubble becomes the timeline row
        dispatch(upsertMessage({
          conversationId: roomId,
          message: { id: messageId, clientId, status: ownStatus(roomId, timestamp, 'sent'), timestamp, ...fields } as Message,
        }));
        if (pendingPreviews.has(clientId)) {
          URL.revokeObjectURL(pendingPreviews.get(clientId)!);
          pendingPreviews.delete(clientId);
        }
        dispatch(updateConversationLastMessage({
          conversationId: roomId,
          lastMessage: local ? messagePreview(fields.text, fields.mediaType, fields.mediaFilename) : 'Encrypted message',
          timestamp,
        }));
      } else if (local && !hasRow(getState, roomId, messageId)) {
        // Sent from another tab of this browser (same device, same local database)
        showTimelineMessage(dispatch, {
          roomId, messageId, senderId: localStorage.getItem('userId'), text: 'e2e2:', timestamp, status: 'sent',
          messageType: fields.mediaType || 'text',
        }, local, false);
      }
    });
  });

  // Another device couldn't decrypt one of our messages: encrypt it again for that device
  wsService.on('e2e_retry_request', (data) => {
    if (data.request) answerRetry(data.request as RetryRequest).catch(() => undefined);
  });

  wsService.on('e2e_device_list', (data) => {
    forgetDirectory(data.userId).catch(() => undefined);
    window.dispatchEvent(new CustomEvent(E2E_DIRECTORY_EVENT));
  });

  // Someone set up or reset their encryption keys
  wsService.on('keys_changed', (data) => {
    e2eService.forgetUser(data.userId);
    window.dispatchEvent(new CustomEvent(E2E_DIRECTORY_EVENT));
    if (data.userId === localStorage.getItem('userId')) {
      // Our own keys were reset on another device: this browser's copy is out of date
      e2eSession.reportStale();
    }
  });

  // Group renamed / photo / members changed
  wsService.on('conversation_updated', (data) => {
    if (data.conversationId) e2eService.forgetConversation(data.conversationId);
    forgetDirectory().catch(() => undefined); // members may have changed
    window.dispatchEvent(new CustomEvent(E2E_DIRECTORY_EVENT));
    dispatch(fetchConversations());
    window.dispatchEvent(new CustomEvent(CONVERSATION_UPDATED_EVENT, { detail: data.conversationId }));
  });

  // We were removed from a group (or left it on another device)
  wsService.on('conversation_removed', (data) => {
    dispatch(fetchConversations());
    if (!data.conversationId) return;

    if ((window as any).__activeConversationId === data.conversationId) {
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: '/chat' }));
    }
    if (!data.left) {
      toast.info(`${data.removedByName || 'An admin'} removed you from "${data.title || 'a group'}"`);
    }
  });

  // Someone created a DM or group that includes us: show it in the chat list right away
  wsService.on('conversation_created', (data) => {
    dispatch(fetchConversations());

    const isOwn = data.createdBy === localStorage.getItem('userId');
    if (!isOwn && data.kind === 'group' && data.conversationId) {
      const path = `/chat/${data.conversationId}`;
      toast.info(`${data.createdByName || 'Someone'} added you to "${data.title || 'a group'}"`, {
        onClick: () => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: path })),
      });
    }
  });

  // Snapshot of everyone online, sent by the server when we connect
  wsService.on('presence', (data) => {
    const userIds = data.userIds || [];
    dispatch(setOnlineUsers(userIds));
    dispatch(syncOnlineStatus({ onlineUserIds: userIds, currentUserId: localStorage.getItem('userId') }));
  });

  // User went offline
  wsService.on('offline', (data) => {


    if (data.userId) {
      dispatch(removeOnlineUser(data.userId));
      dispatch(updateUserOnlineStatus({ userId: data.userId, isOnline: false }));
    }
  });

  // Joined conversation
  wsService.on('joined', (data) => {
  });

  // Left conversation
  wsService.on('left', (data) => {
  });

  // Error
  wsService.on('error', (data) => {
    console.error('❌ WebSocket error:', data.message);

    // Someone's devices changed since we fetched their lists: fetch them again and resend, once
    if (data.code === 'devices_changed' && data.clientId && data.roomId) {
      const users = Array.from(new Set([...(data.missing || []), ...(data.extra || [])].map((d: { user: string }) => d.user)));
      const failed = { conversationId: data.roomId, messageId: data.clientId, updates: { status: 'failed' as const, uploadProgress: undefined } };
      resendAfterDevicesChanged(data.clientId, users)
        .then(sent => { if (!sent) { dispatch(updateMessage(failed)); toast.error(`Message not sent: ${data.message || 'unknown error'}`); } })
        .catch(() => { dispatch(updateMessage(failed)); toast.error('Message not sent'); });
      return;
    }

    // Server rejected one of our messages
    if (data.clientId && data.roomId) {
      dispatch(updateMessage({
        conversationId: data.roomId,
        messageId: data.clientId,
        updates: { status: 'failed', uploadProgress: undefined }
      }));
      toast.error(`Message not sent: ${data.message || 'unknown error'}`);
      return;
    }

    dispatch(setError(data.message || 'WebSocket error'));
  });

  // Connection events
  // Messages, reads and group changes sent while we were offline aren't replayed
  // over the socket, so reload them from the API after a reconnect.
  let missedEvents = false;

  wsService.on('connected', () => {
    dispatch(setConnected(true));
    dispatch(syncV2()); // v2 packets that arrived while we were away

    if (missedEvents) {
      missedEvents = false;
      dispatch(fetchConversations());
      const activeId = (window as any).__activeConversationId;
      if (activeId) dispatch(fetchMessages(activeId));
    }
  });

  wsService.on('disconnected', () => {
    missedEvents = true;
    dispatch(setConnected(false));
  });
}