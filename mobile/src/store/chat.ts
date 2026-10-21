// src/store/chat.ts
// Chats and messages, kept up to date by the WebSocket (mirrors the web app's chat slice).

import { AppState } from 'react-native';
import { create } from 'zustand';
import { chatApi, Conversation, Message, MuteDuration, ReplyPreview } from '../api/chat';
import { OutgoingMedia, socket, WsEvent } from '../websocket/socket';
import { LocalFile, UploadQuality, uploadFile } from '../api/media';
import { createThumbnail } from 'react-native-create-thumbnail';
import { decryptedFields, decryptMessage, mediaLabel, NOT_ENCRYPTED_TEXT, openText, recipientsFor, sealFor, unverifiedMessages } from '../crypto/messages';
import { encryptForUpload, rememberDecrypted } from '../crypto/media';
import type { E2EMedia } from '../crypto/e2e';
import { e2eSession } from '../crypto/session';
import { useAuth } from './auth';
import { e2eService } from '../services/e2e.service';
import {
  answerRetry, answerWaitingRetries, askAgain, confirmOwn, drainMailbox, forgetDirectory, forwardV2, fromLocal, isV2Marker, joinedAt, lastLocal,
  localFor, myDeviceId, pendingFields, pointerOf, receiveLive, resendAfterDevicesChanged, sendMediaV2, sendTextV2, v2For,
  warmChat,
} from '../crypto/v2-platform/chat';
import type { ChatInfo, RetryRequest } from '../crypto/v2-platform/chat';
import type { EnvelopeMeta, LocalMessage, Received } from '../crypto/v2';
import { showAlert } from '../components/common/Dialog';
import { clearChatNotifications } from '../notifications/push';

const TYPING_TTL_MS = 6000;

interface ChatState {
  conversations: Conversation[];
  loaded: boolean;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, Record<string, { name?: string; until: number }>>;
  online: string[];
  connected: boolean;
  activeId: string | null;

  loadConversations: () => Promise<void>;
  loadMessages: (conversationId: string) => Promise<void>;
  loadOlder: (conversationId: string) => Promise<void>;
  open: (conversationId: string | null) => void;
  send: (conversationId: string, text: string, me: { id: string; username: string }, replyTo?: ReplyPreview | null) => void;
  retry: (conversationId: string, clientId: string) => void;
  sendMedia: (conversationId: string, attachment: Attachment, me: { id: string; username: string }, replyTo?: ReplyPreview | null) => void;
  cancelUpload: (conversationId: string, clientId: string) => void;
  retryUpload: (clientId: string) => void;
  forward: (message: Message, conversationIds: string[]) => Promise<{ sent: number; skipped: number }>;
  setPinned: (conversationId: string, pinned: boolean) => void;
  /** You blocked or unblocked someone (here or on another of your devices). */
  setBlocked: (userId: string, blocked: boolean) => void;
  /** Mute / archive for you (from this phone or another of your devices). */
  setPrefs: (conversationId: string, prefs: { mutedUntil?: string | null; isArchived?: boolean }) => void;
  mute: (conversationId: string, duration: MuteDuration | null) => Promise<void>;
  archive: (conversationId: string, archived: boolean) => Promise<void>;
  reset: () => void;
}

// Latest message time each chat has been read up to on this phone. The server learns about
// reads a moment later, so a list refresh in between must not bring back an old unread count.
const readUpTo: Record<string, number> = {};
const markReadLocally = (conversationId: string, at = Date.now()) => {
  readUpTo[conversationId] = Math.max(readUpTo[conversationId] || 0, at);
};

const byTime = (a: Message, b: Message) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
let counter = 0;
const newClientId = () => `temp-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  loaded: false,
  messages: {},
  hasMore: {},
  typing: {},
  online: [],
  connected: false,
  activeId: null,

  loadConversations: async () => {
    const conversations = (await chatApi.conversations()).map((c) =>
      c.unreadCount && readUpTo[c.id] && c.lastMessageTime && new Date(c.lastMessageTime).getTime() <= readUpTo[c.id]
        ? { ...c, unreadCount: 0 }
        : c,
    );
    // v2 chats: the server only knows a message was sent; the preview comes from this phone's
    // copy. Look those up before showing the list, so a refresh never flashes the raw envelope.
    // (The keys may still be starting up: don't hold the list for long, fill those rows in later.)
    const shown = Object.fromEntries(get().conversations.map((c) => [c.id, c]));
    const late: { id: string; lookup: Promise<LocalMessage | null> }[] = [];
    let joined: Promise<number | null> | null = null;
    const joinedOnce = () => (joined ??= joinedAt().catch(() => null));
    const previews = await Promise.all(conversations.map(async (c) => {
      if (!isV2Marker(c.lastMessage)) return c.lastMessage;
      const lookup = lastLocal(c.id).catch(() => null);
      const m = await Promise.race([lookup, new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), 800))]);
      if (m && m !== 'slow') return previewOf({ ...fromLocal(m) } as Message);
      if (m === 'slow') late.push({ id: c.id, lookup });
      // Sent before this phone was linked (both from the server's clock): it was never encrypted for it
      const since = m === null ? await joinedOnce() : null;
      if (since && c.lastMessageTime && Date.parse(c.lastMessageTime) < since) return 'Sent before this phone was linked';
      // Not looked up yet, or not on this phone: keep what the row already shows if it's readable
      // (the same message, or a newer one from the socket; times compared as dates, the server and
      // the socket write them differently). Still looking: the row fills in when the lookup ends.
      const before = shown[c.id];
      const readable = before && before.lastMessage && !isV2Marker(before.lastMessage) && before.lastMessage !== 'Encrypted message';
      const sameOrNewer = !!before?.lastMessageTime && !!c.lastMessageTime && Date.parse(before.lastMessageTime) >= Date.parse(c.lastMessageTime);
      if (readable && (m === 'slow' || sameOrNewer)) return before.lastMessage;
      return m === 'slow' ? '' : 'Encrypted message';
    }));
    // A message that arrived over the socket meanwhile is newer than this list: keep it
    const now = Object.fromEntries(get().conversations.map((c) => [c.id, c]));
    const withPreviews = conversations.map((c, n) => {
      const live = now[c.id];
      if (live?.lastMessageTime && (!c.lastMessageTime || new Date(live.lastMessageTime) > new Date(c.lastMessageTime))) {
        return { ...c, lastMessage: live.lastMessage, lastMessageTime: live.lastMessageTime };
      }
      return previews[n] === c.lastMessage ? c : { ...c, lastMessage: previews[n] };
    });
    set({ conversations: withPreviews, loaded: true });
    late.forEach(({ id, lookup }) => lookup.then((m) => {
      // Found: its text. Not on this phone: say so, but only where the row is still waiting (empty)
      const preview = m ? previewOf({ ...fromLocal(m) } as Message) : null;
      set((s) => ({
        conversations: s.conversations.map((x) => (x.id !== id ? x : preview !== null ? { ...x, lastMessage: preview }
          : x.lastMessage === '' ? { ...x, lastMessage: 'Encrypted message' } : x)),
      }));
    }));
    // Read on another device (or here) while this phone was away: their notifications go too
    clearChatNotifications(withPreviews.filter((c) => !c.unreadCount).map((c) => c.id));
  },

  loadMessages: async (conversationId) => {
    warmChat(chatInfo(conversationId)); // device lists ready before the first message
    const page = await chatApi.messages(conversationId);
    const messages = await resolveV2(page.messages);
    const { hasMore } = page;
    // keep messages still being sent
    const pending = (get().messages[conversationId] || []).filter((m) => m.id.startsWith('temp-'));
    set((s) => ({
      messages: { ...s.messages, [conversationId]: [...messages, ...pending].sort(byTime) },
      hasMore: { ...s.hasMore, [conversationId]: hasMore },
    }));
    flagUnverified(conversationId, messages);
  },

  loadOlder: async (conversationId) => {
    const current = get().messages[conversationId] || [];
    const oldest = current.find((m) => !m.id.startsWith('temp-'));
    if (!oldest) return;
    const page = await chatApi.messages(conversationId, oldest.id);
    const messages = await resolveV2(page.messages);
    const { hasMore } = page;
    const known = new Set(current.map((m) => m.id));
    set((s) => ({
      messages: { ...s.messages, [conversationId]: [...messages.filter((m) => !known.has(m.id)), ...current] },
      hasMore: { ...s.hasMore, [conversationId]: hasMore },
    }));
    flagUnverified(conversationId, messages);
  },

  open: (conversationId) => {
    const previous = get().activeId;
    if (previous && previous !== conversationId) {
      socket.leave(previous);
      // Leaving: make sure the server knows everything seen here is read
      markReadLocally(previous);
      chatApi.markRead(previous).catch(() => undefined);
    }
    set({ activeId: conversationId });
    if (!conversationId) return;
    markReadLocally(conversationId);
    clearChatNotifications([conversationId]);
    socket.join(conversationId);
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)) }));
    chatApi.markRead(conversationId).catch(() => undefined);
  },

  send: (conversationId, text, me, replyTo) => {
    const clientId = newClientId();
    const message: Message = {
      id: clientId,
      clientId,
      conversationId,
      senderId: me.id,
      senderName: me.username,
      text,
      timestamp: new Date().toISOString(),
      status: 'sending',
      replyTo: replyTo || null,
      reactions: [],
    };
    set((s) => ({ messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] || []), message] } }));
    sendText(conversationId, clientId, text, replyTo?.id);
  },

  retry: (conversationId, clientId) => {
    const message = (get().messages[conversationId] || []).find((m) => m.id === clientId);
    if (!message) return;
    updateMessage(set, conversationId, clientId, { status: 'sending' });
    sendText(conversationId, clientId, message.text, message.replyTo?.id);
  },

  sendMedia: (conversationId, attachment, me, replyTo) => {
    const clientId = newClientId();
    const message: Message = {
      id: clientId,
      clientId,
      conversationId,
      senderId: me.id,
      senderName: me.username,
      text: attachment.caption,
      timestamp: new Date().toISOString(),
      status: 'sending',
      mediaUrl: attachment.file.uri, // local preview until the server copy arrives
      mediaType: attachment.kind,
      mediaFilename: attachment.file.name,
      mediaSize: attachment.size,
      mediaWidth: attachment.width,
      mediaHeight: attachment.height,
      mediaDuration: attachment.duration,
      uploadProgress: 0,
      replyTo: replyTo || null,
      reactions: [],
    };
    set((s) => ({ messages: { ...s.messages, [conversationId]: [...(s.messages[conversationId] || []), message] } }));
    uploads.set(clientId, { conversationId, attachment, replyTo });
    uploadAndSend(clientId);
  },

  cancelUpload: (conversationId, clientId) => {
    uploads.get(clientId)?.controller?.abort();
    uploads.delete(clientId);
    set((s) => ({ messages: { ...s.messages, [conversationId]: (s.messages[conversationId] || []).filter((m) => m.id !== clientId) } }));
  },

  retryUpload: (clientId) => uploadAndSend(clientId),

  forward: async (message, conversationIds) => {
    if (message.id.startsWith('temp-')) return { sent: 0, skipped: 0 };
    const encryptedMedia = mediaPayloadOf(message);
    const plainMedia: OutgoingMedia | undefined = message.mediaUrl && message.mediaType
      ? {
          mediaUrl: message.mediaUrl, // the server drops the link's signature and checks it's ours
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
    for (const id of conversationIds) {
      const chat = chatInfo(id);
      const v2 = await v2For(chat).catch(() => null);
      const v2Pointer = pointerOf(message);
      if (v2 && (v2Pointer || !message.mediaUrl)) {
        if (await forwardV2(v2, chat, newClientId(), message.text || '', v2Pointer).catch(() => false)) sent += 1;
        continue;
      }
      if (v2Pointer) {
        skipped += 1; // a v2 file can only go to a chat that uses v2
        continue;
      }
      // Encrypted files are re-used as they are: only their key is sealed again for the new chat
      const sealed = await sealFor(id, { t: message.text || '', m: encryptedMedia });
      if (!sealed) {
        skipped += 1; // nothing goes to a chat that isn't end-to-end encrypted yet
        continue;
      }
      const media = encryptedMedia
        ? { mediaUrl: message.mediaUrl!, mediaType: message.mediaType!, mediaThumbnail: message.mediaThumbnail }
        : plainMedia;
      if (socket.sendMessage(id, newClientId(), sealed.text, undefined, media, sealed.hasLink)) sent += 1;
    }
    return { sent, skipped };
  },

  setBlocked: (userId, blocked) =>
    set((s) => ({ conversations: s.conversations.map((c) => (c.otherUserId === userId ? { ...c, isBlocked: blocked } : c)) })),
  setPinned: (conversationId, pinned) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, isPinned: pinned, pinnedAt: pinned ? new Date().toISOString() : null } : c,
      ),
    })),

  setPrefs: (conversationId, prefs) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id !== conversationId ? c : {
        ...c, ...prefs, ...(prefs.isArchived ? { isPinned: false, pinnedAt: null } : {}),
      })),
    })),

  mute: async (conversationId, duration) => {
    const before = get().conversations.find((c) => c.id === conversationId)?.mutedUntil ?? null;
    const hours = { '8h': 8, '1w': 24 * 7, always: 24 * 365 * 100 };
    get().setPrefs(conversationId, { mutedUntil: duration ? new Date(Date.now() + hours[duration] * 3600e3).toISOString() : null });
    try {
      const r = await chatApi.mute(conversationId, duration);
      get().setPrefs(conversationId, { mutedUntil: r.mutedUntil });
    } catch (e) {
      get().setPrefs(conversationId, { mutedUntil: before });
      throw e;
    }
  },

  archive: async (conversationId, archived) => {
    get().setPrefs(conversationId, { isArchived: archived });
    try {
      await chatApi.archive(conversationId, archived);
    } catch (e) {
      get().setPrefs(conversationId, { isArchived: !archived });
      throw e;
    }
  },

  reset: () => set({ conversations: [], loaded: false, messages: {}, hasMore: {}, typing: {}, online: [], activeId: null }),
}));

type Setter = (fn: (s: ChatState) => Partial<ChatState>) => void;

/**
 * The signed-in user. Not e2eSession.userId(): that is only set when this phone has the old (v1)
 * keys, so phones without them took their own messages for someone else's.
 */
const myId = () => useAuth.getState().user?.id ?? null;

/** Who is in a conversation (for encryption v2), from the chat list. */
function chatInfo(conversationId: string): ChatInfo {
  const c = useChat.getState().conversations.find((x) => x.id === conversationId);
  return { conversationId, isGroup: !!c?.isGroup, members: c?.members || [] };
}

/** Show what v2 decrypted: fill the timeline row (or edit) and the chat list preview. */
function applyV2(r: Received) {
  if (r.kind !== 'message' && r.kind !== 'edit') return;
  const set = useChat.setState as unknown as Setter;
  const m = r.message;
  const list = useChat.getState().messages[m.conv] || [];
  const row = list.find((x) => (m.serverId && x.id === m.serverId) || x.localId === m.id);
  if (row) updateMessage(set, m.conv, row.id, fromLocal(m));
  if (r.kind === 'message') {
    const f = fromLocal(m);
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === m.conv ? { ...c, lastMessage: previewOf({ ...(row || {}), ...f } as Message) } : c)) }));
  }
}

/** Process this phone's v2 mailbox (after starting or reconnecting). */
export const syncV2 = () => drainMailbox((r) => applyV2(r))
  .then(() => answerWaitingRetries()) // devices that asked for one of our messages again
  .catch(() => undefined);

/**
 * v2 rows (and quoted v2 messages): fill from this phone's local database before they're shown,
 * all at once. Showing "Waiting for this message…" placeholders first and filling them one by
 * one made every opened chat flash (a column of purple placeholder bubbles) and re-render per message.
 */
async function resolveV2(messages: Message[]): Promise<Message[]> {
  let joined: Promise<number | null> | null = null;
  const joinedOnce = () => (joined ??= joinedAt().catch(() => null));
  return Promise.all(messages.map(async (m) => {
    let out = m;
    if (m.e2eVersion === 2 && m.e2e === 'pending') {
      const local = await localFor(m.id).catch(() => null);
      if (local) {
        out = { ...out, ...fromLocal(local) };
      } else {
        // Sent before this phone was linked (both times from the server's clock): it will never arrive here
        const since = await joinedOnce();
        if (since && Date.parse(m.timestamp) < since) out = { ...out, e2e: 'unreadable' };
      }
    }
    if (m.replyTo && isV2Marker(m.replyTo.text)) {
      const local = await localFor(m.replyTo.id).catch(() => null);
      out = { ...out, replyTo: { ...m.replyTo, text: local ? fromLocal(local).text || 'Attachment' : 'Encrypted message' } };
    }
    return out;
  }));
}

/** Send a text message, end-to-end encrypted when everyone in the chat has set up encryption. */
async function sendText(conversationId: string, clientId: string, text: string, replyToId?: string) {
  const set = useChat.setState as unknown as Setter;
  // Encryption v2 when everyone in the chat has it set up; otherwise v1 (or plain) as before
  const chat = chatInfo(conversationId);
  const v2 = await v2For(chat).catch(() => null);
  if (v2) {
    updateMessage(set, conversationId, clientId, { e2eVersion: 2, localId: clientId });
    try {
      if (await sendTextV2(v2, chat, clientId, text, replyToId ? ({ id: replyToId } as ReplyPreview) : null)) return;
    } catch {
      // shown as not sent
    }
    updateMessage(set, conversationId, clientId, { status: 'failed' });
    return;
  }
  try {
    const sealed = await sealFor(conversationId, { t: text });
    if (sealed && socket.sendMessage(conversationId, clientId, sealed.text, replyToId, undefined, sealed.hasLink)) return;
  } catch {
    // keys out of date (reset on another device) or offline: shown as not sent
  }
  updateMessage(set, conversationId, clientId, { status: 'failed' });
}

/** Mark encrypted messages whose signature isn't from their sender's key (checked in the background). */
function flagUnverified(conversationId: string, messages: Message[]) {
  const set = useChat.setState as unknown as Setter;
  unverifiedMessages(messages)
    .then((ids) => ids.forEach((id) => updateMessage(set, conversationId, id, { e2eUnverified: true })))
    .catch(() => undefined);
}

/** The encrypted-file part of a message, to put in a new envelope (forward, edit). */
export const mediaPayloadOf = (m: Message): E2EMedia | undefined =>
  m.mediaKey && m.mediaType
    ? {
        key: m.mediaKey, type: m.mediaType, mime: m.mediaMime || 'application/octet-stream', name: m.mediaFilename,
        size: m.mediaSize, w: m.mediaWidth, h: m.mediaHeight, d: m.mediaDuration, tk: m.thumbKey,
      }
    : undefined;

// ---- attachments: upload first, then send the message by URL (same as the web app)
export interface Attachment {
  file: LocalFile;
  kind: 'image' | 'video' | 'audio' | 'file';
  caption: string;
  quality: UploadQuality;
  size?: number;
  width?: number;
  height?: number;
  duration?: number; // seconds (voice notes, videos)
}

const uploads = new Map<string, {
  conversationId: string;
  attachment: Attachment;
  replyTo?: ReplyPreview | null;
  controller?: AbortController;
  sent?: OutgoingMedia; // uploaded already: a retry only resends the message
  sealed?: { text: string; hasLink: boolean }; // encrypted chats: the envelope carrying the file's key
}>();

async function uploadAndSend(clientId: string) {
  const job = uploads.get(clientId);
  if (!job) return;
  const { conversationId, attachment, replyTo } = job;
  const set = useChat.setState as unknown as Setter;
  const controller = new AbortController();
  job.controller = controller;
  updateMessage(set, conversationId, clientId, { status: 'sending', uploadFailed: undefined, uploadProgress: 0 });
  try {
    const kind = attachment.quality === 'original' && attachment.kind !== 'audio' ? 'file' : attachment.kind;
    // Encryption v2: the file (PMV2) and its key travel only to the chat's devices
    const chat = chatInfo(conversationId);
    const v2 = job.sent ? null : await v2For(chat).catch(() => null);
    if (v2) {
      updateMessage(set, conversationId, clientId, { e2eVersion: 2, localId: clientId });
      const result = await sendMediaV2(v2, chat, clientId, attachment.file, kind, attachment.caption, {
        width: attachment.width, height: attachment.height, duration: attachment.duration, replyTo, signal: controller.signal,
        onProgress: (percent) => updateMessage(set, conversationId, clientId, { uploadProgress: Math.min(percent, 99) }),
      });
      if (result.posterUri) updateMessage(set, conversationId, clientId, { mediaThumbnail: result.posterUri, mediaWidth: result.width, mediaHeight: result.height });
      if (result.sent) {
        uploads.delete(clientId);
        updateMessage(set, conversationId, clientId, { uploadProgress: undefined });
      } else {
        updateMessage(set, conversationId, clientId, { status: 'failed', uploadFailed: true, uploadProgress: undefined });
      }
      return;
    }
    if (!job.sent && (await recipientsFor(conversationId))) {
      // End-to-end encrypted chat: encrypt the file (and a video's preview frame) on the phone.
      // The server can't compress or look at it; name, size and the key go inside the message.
      const progress = (percent: number) => updateMessage(set, conversationId, clientId, { uploadProgress: Math.min(percent, 99) });
      let posterUrl: string | undefined;
      let posterKey: string | undefined;
      let width = attachment.width;
      let height = attachment.height;
      if (kind === 'video') {
        try {
          const poster = await createThumbnail({ url: attachment.file.uri, timeStamp: 500, format: 'jpeg' });
          width = poster.width || width;
          height = poster.height || height;
          const sealedPoster = await encryptForUpload({ uri: poster.path, type: 'image/jpeg' });
          const up = await uploadFile({ uri: sealedPoster.uri, type: 'application/octet-stream', name: 'file.enc' }, { signal: controller.signal, encrypted: 'image' });
          posterUrl = up.url;
          posterKey = sealedPoster.key;
          await rememberDecrypted(up.url, sealedPoster.key, poster.path, 'image/jpeg');
          updateMessage(set, conversationId, clientId, { mediaThumbnail: poster.path, mediaWidth: width, mediaHeight: height });
        } catch {
          // no preview frame: the video still sends
        }
      }
      const sealedFile = await encryptForUpload(attachment.file);
      const uploaded = await uploadFile({ uri: sealedFile.uri, type: 'application/octet-stream', name: 'file.enc' }, {
        signal: controller.signal, onProgress: progress, encrypted: kind,
      });
      await rememberDecrypted(uploaded.url, sealedFile.key, attachment.file.uri, attachment.file.type);
      const m: E2EMedia = {
        key: sealedFile.key, type: kind, mime: attachment.file.type, name: attachment.file.name, size: sealedFile.size,
        w: width, h: height, d: attachment.duration, tk: posterKey,
      };
      const sealed = await sealFor(conversationId, { t: attachment.caption, m });
      if (!sealed) throw new Error("This chat isn't encrypted any more");
      job.sealed = sealed;
      job.sent = { mediaUrl: uploaded.url, mediaType: kind, mediaThumbnail: posterUrl };
    }
    if (!job.sent || !job.sealed) throw new Error(NOT_ENCRYPTED_TEXT); // never upload or send a readable file
    if (socket.sendMessage(conversationId, clientId, job.sealed.text, replyTo?.id, job.sent, job.sealed.hasLink)) {
      uploads.delete(clientId);
      updateMessage(set, conversationId, clientId, { uploadProgress: undefined });
    } else {
      updateMessage(set, conversationId, clientId, { status: 'failed', uploadFailed: true, uploadProgress: undefined });
    }
  } catch {
    if (controller.signal.aborted) return; // cancelled
    updateMessage(set, conversationId, clientId, { status: 'failed', uploadFailed: true, uploadProgress: undefined });
  }
}

function updateMessage(set: Setter, conversationId: string, messageId: string, patch: Partial<Message>) {
  set((s) => ({
    messages: {
      ...s.messages,
      [conversationId]: (s.messages[conversationId] || []).map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
    },
  }));
}

const previewOf = (m: Message) => m.text || (m.mediaType ? mediaLabel({ type: m.mediaType, name: m.mediaFilename }) : '');

/** Listeners other screens can hook into (expenses, receipts). */
type Extra = (event: WsEvent) => void;
const extras = new Set<Extra>();
export const onServerEvent = (listener: Extra) => {
  extras.add(listener);
  return () => {
    extras.delete(listener);
  };
};

// ---- live events
// This module loads lazily (on first use, after the encryption check): the socket may already be open
useChat.setState({ connected: socket.connected });
socket.onStatus((connected) => {
  useChat.setState({ connected });
  if (connected) {
    syncV2(); // v2 packets that arrived while we were away
    const { activeId, loadConversations, loadMessages } = useChat.getState();
    loadConversations().catch(() => undefined); // catch up on anything missed while offline
    if (activeId) loadMessages(activeId).catch(() => undefined);
  }
});

/** The app is in front of the user (an open chat in the background isn't being read). */
export const onScreen = () => AppState.currentState === 'active';

let appState = AppState.currentState;
AppState.addEventListener('change', (next) => {
  const back = /inactive|background/.test(appState) && next === 'active';
  appState = next;
  if (!back) return;
  const { activeId, loadConversations, loadMessages } = useChat.getState();
  // Back to a chat that stayed open: what came meanwhile is read now (not while the app was away)
  if (activeId) useChat.getState().open(activeId);
  // With the WebSocket still open: phones can keep it connected in the background while blocking the
  // app's other network requests, so packets that came then may be waiting to be read
  if (!socket.connected) return; // reconnecting does the same (onStatus above)
  syncV2();
  loadConversations().catch(() => undefined);
  if (activeId) loadMessages(activeId).catch(() => undefined);
});

/**
 * Put a timeline message in the chat: a `message` event (plain and version 1 chats, and version 2 from
 * a server without protocol 3), or an encrypted (v2) message with its details from its envelope.
 * `v2Local`: this phone's decrypted copy (null: couldn't be read, shown as waiting; undefined: not from
 * an envelope). `countUnread`: false for a copy that was already counted.
 */
function showTimelineMessage(e: WsEvent, v2Local?: LocalMessage | null, countUnread = true) {
  if (!e.roomId || !e.messageId) return;
  const set = useChat.setState as unknown as Setter;
  const state = useChat.getState();
  const message: Message = decryptMessage({
    id: e.messageId,
    conversationId: e.roomId,
    senderId: e.senderId || '',
    senderName: e.senderName,
    senderAvatar: e.senderAvatar,
    text: e.text || '',
    timestamp: e.timestamp || new Date().toISOString(),
    status: (e.status as Message['status']) || 'delivered',
    messageType: e.messageType,
    mediaUrl: e.mediaUrl || undefined,
    mediaType: e.mediaType || undefined,
    mediaFilename: e.mediaFilename || undefined,
    mediaSize: e.mediaSize || undefined,
    mediaThumbnail: e.mediaThumbnail || undefined,
    mediaWidth: e.mediaWidth || undefined,
    mediaHeight: e.mediaHeight || undefined,
    mediaDuration: e.mediaDuration || undefined,
    replyTo: e.replyTo || null,
    reactions: [],
    expenseId: e.expenseId || null,
  } as Message);
  // Quoting a v2 message: the server only has its marker; the quoted text is in this phone's copy
  const quoted = message.replyTo;
  if (quoted && isV2Marker(quoted.text)) {
    message.replyTo = { ...quoted, text: '' };
    localFor(quoted.id).then((local) => {
      updateMessage(set, e.roomId, e.messageId, { replyTo: { ...quoted, text: local ? fromLocal(local).text || 'Attachment' : 'Encrypted message' } });
    }).catch(() => undefined);
  }
  const mine = e.senderId === myId();
  const v2Row = isV2Marker(e.text);
  if (v2Row && v2Local !== undefined) {
    // From its envelope: already decrypted (or known to be unreadable for now)
    Object.assign(message, v2Local ? fromLocal(v2Local) : pendingFields);
    if (mine) message.status = ownStatus(e.roomId, message.timestamp, message.status);
  } else if (v2Row) {
    Object.assign(message, pendingFields);
    // A marker row without its packet (a server without protocol 3): the content comes in this
    // phone's own packet; ours is already in the local database
    const own = !!e.clientId && mine;
    (own ? confirmOwn(e.clientId, e.messageId) : localFor(e.messageId)).then((local) => {
      if (!local) return;
      const fields = fromLocal(local);
      updateMessage(set, e.roomId, e.messageId, fields);
      // Replace the "Encrypted message" placeholder in the chat list, unless a newer message came since
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === e.roomId && c.lastMessageTime === message.timestamp ? { ...c, lastMessage: previewOf({ ...message, ...fields } as Message) } : c,
        ),
      }));
    }).catch(() => undefined);
  } else {
    flagUnverified(e.roomId, [message]);
  }
  // The server passes the sender's clientId to every member: only the sender's id says it's ours
  set((s) => {
    const list = (s.messages[e.roomId] || []).filter((m) => m.id !== message.id && (!e.clientId || m.id !== e.clientId));
    const active = s.activeId === e.roomId && onScreen();
    return {
      messages: s.messages[e.roomId] || active ? { ...s.messages, [e.roomId]: [...list, message].sort(byTime) } : s.messages,
      conversations: s.conversations.map((c) =>
        c.id === e.roomId
          ? {
              ...c,
              lastMessage: message.e2e === 'unreadable' || message.e2e === 'pending' ? 'Encrypted message' : previewOf(message),
              lastMessageTime: message.timestamp,
              unreadCount: active || mine || !countUnread ? c.unreadCount : c.unreadCount + 1,
            }
          : c,
      ),
    };
  });
  if (!state.conversations.some((c) => c.id === e.roomId)) state.loadConversations().catch(() => undefined);
  if (!mine && e.messageType !== 'system') socket.delivered(e.roomId, e.messageId);
  if (state.activeId === e.roomId && onScreen()) {
    markReadLocally(e.roomId, new Date(message.timestamp).getTime());
    if (!mine) socket.read(e.roomId, e.messageId);
  }
}

// ---------------------------------------------------------------- envelope-first (protocol 3)
// An encrypted message enters the chat only once this phone has decrypted its own packet, which
// carries the message's details (`meta`), as on Signal and WhatsApp: never a blank bubble first.
// A packet that can't be read yet shows "Waiting for this message…" only after a grace period; one
// that can't be read at all asks the sender's device to encrypt it again.

const WAITING_GRACE_MS = 4000;
/** Packets waiting for a group key (or the network): their details, to show them once they're read. */
const waitingMeta = new Map<string, EnvelopeMeta>();

const metaEvent = (meta: EnvelopeMeta): WsEvent => ({ type: 'message', ...meta, text: 'e2e2:', status: 'sent' });

const hasRow = (roomId: string, messageId: string) =>
  (useChat.getState().messages[roomId] || []).some((m) => m.id === messageId);

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

function showEnvelope(r: Received, meta: EnvelopeMeta) {
  switch (r.kind) {
    case 'message':
      waitingMeta.delete(meta.messageId);
      showTimelineMessage(metaEvent(meta), r.message);
      return;
    case 'duplicate':
      if (r.message && !hasRow(meta.roomId, meta.messageId)) showTimelineMessage(metaEvent(meta), r.message, false);
      return;
    case 'waiting':
      waitingMeta.set(meta.messageId, meta);
      setTimeout(() => {
        if (waitingMeta.has(meta.messageId) && !hasRow(meta.roomId, meta.messageId)) showTimelineMessage(metaEvent(meta), null);
      }, WAITING_GRACE_MS);
      return;
    case 'failed':
      showTimelineMessage(metaEvent(meta), null);
      askAgain(meta.messageId, meta.fromDevice).catch(() => undefined);
      return;
    default:
      applyV2(r);
  }
}

/** A packet that had to wait can be read now: show it if it never made it into the chat. */
function showLater(r: Received) {
  const meta = r.kind === 'message' && r.message.serverId ? waitingMeta.get(r.message.serverId) : undefined;
  if (meta && !hasRow(meta.roomId, meta.messageId)) showEnvelope(r, meta);
  else applyV2(r);
  if (meta) waitingMeta.delete(meta.messageId);
}

/** The server took one of our encrypted messages: link our copy to its timeline row. */
async function onMessageSent(e: WsEvent) {
  const { roomId, messageId, clientId, fromDevice } = e;
  if (!roomId || !messageId || !clientId) return;
  if (fromDevice !== (await myDeviceId())) return; // sent from another of my devices: its envelope shows it
  const local = await confirmOwn(clientId, messageId).catch(() => null);
  const timestamp: string = e.timestamp || new Date().toISOString();
  const set = useChat.setState as unknown as Setter;
  if (hasRow(roomId, clientId)) {
    // The optimistic bubble becomes the timeline row
    const fields = local ? fromLocal(local) : {};
    set((s) => {
      const list = (s.messages[roomId] || []).map((m) =>
        m.id === clientId ? { ...m, ...fields, id: messageId, status: ownStatus(roomId, timestamp, 'sent'), timestamp } : m,
      );
      return {
        messages: { ...s.messages, [roomId]: list.sort(byTime) },
        conversations: s.conversations.map((c) =>
          c.id === roomId ? { ...c, lastMessage: local ? previewOf({ ...fields } as Message) : 'Encrypted message', lastMessageTime: timestamp } : c,
        ),
      };
    });
  } else if (local && !hasRow(roomId, messageId)) {
    const fields = fromLocal(local);
    showTimelineMessage({
      type: 'message', roomId, messageId, senderId: myId(), text: 'e2e2:', timestamp, status: 'sent', messageType: fields.mediaType || 'text',
    }, local, false);
  }
}

socket.on((e) => {
  const set = useChat.setState as unknown as Setter;
  const state = useChat.getState();
  switch (e.type) {
    case 'message':
      showTimelineMessage(e);
      break;
    case 'message_sent':
      onMessageSent(e);
      break;
    case 'e2e_retry_request':
      // Another device couldn't decrypt one of our messages: encrypt it again for that device
      if (e.request) answerRetry(e.request as RetryRequest).catch(() => undefined);
      break;
    case 'error':
      if (e.code === 'devices_changed' && e.roomId && e.clientId) {
        // Someone's devices changed since we fetched their lists: fetch them again and resend, once
        const roomId: string = e.roomId;
        const clientId: string = e.clientId;
        const users = Array.from(new Set([...(e.missing || []), ...(e.extra || [])].map((d: { user: string }) => d.user)));
        const failed = () => updateMessage(set, roomId, clientId, { status: 'failed', ...(uploads.has(clientId) ? { uploadFailed: true } : {}) });
        resendAfterDevicesChanged(clientId, users).then((sent) => { if (!sent) failed(); }).catch(failed);
        break;
      }
      if (e.roomId && e.clientId) {
        updateMessage(set, e.roomId, e.clientId, { status: 'failed', ...(uploads.has(e.clientId) ? { uploadFailed: true } : {}) });
      }
      break;
    case 'typing': {
      if (!e.roomId || !e.userId) break;
      set((s) => {
        const room = { ...(s.typing[e.roomId] || {}) };
        if (e.isTyping) room[e.userId] = { name: e.userName, until: Date.now() + TYPING_TTL_MS };
        else delete room[e.userId];
        return { typing: { ...s.typing, [e.roomId]: room } };
      });
      break;
    }
    case 'delivered':
      if (e.roomId && e.deliveredUpTo) {
        noteReceipt(e.roomId, 'delivered', e.deliveredUpTo);
        const upTo = new Date(e.deliveredUpTo).getTime();
        set((s) => ({
          messages: {
            ...s.messages,
            [e.roomId]: (s.messages[e.roomId] || []).map((m) =>
              m.status === 'sent' && new Date(m.timestamp).getTime() <= upTo ? { ...m, status: 'delivered' } : m,
            ),
          },
        }));
      }
      break;
    case 'read':
      if (e.roomId && e.userId && e.userId === myId()) {
        // We read this chat on another device: no unread badge or notification left here
        markReadLocally(e.roomId);
        clearChatNotifications([e.roomId]);
        set((s) => ({ conversations: s.conversations.map((c) => (c.id === e.roomId ? { ...c, unreadCount: 0 } : c)) }));
      }
      if (e.roomId && e.readUpTo) {
        noteReceipt(e.roomId, 'read', e.readUpTo);
        const upTo = new Date(e.readUpTo).getTime();
        set((s) => ({
          messages: {
            ...s.messages,
            [e.roomId]: (s.messages[e.roomId] || []).map((m) =>
              !m.id.startsWith('temp-') && new Date(m.timestamp).getTime() <= upTo ? { ...m, status: 'read' } : m,
            ),
          },
        }));
      }
      break;
    case 'presence':
      set(() => ({ online: e.userIds || [] }));
      break;
    case 'online':
      if (e.userId) set((s) => ({ online: Array.from(new Set([...s.online, e.userId])) }));
      break;
    case 'offline':
      if (e.userId) set((s) => ({ online: s.online.filter((id) => id !== e.userId) }));
      break;
    case 'message_updated':
      if (e.roomId && e.messageId) {
        // An edited encrypted message comes as a new envelope: decrypt it with the original sender
        const senderId = (state.messages[e.roomId] || []).find((m) => m.id === e.messageId)?.senderId;
        const opened = senderId && !e.isDeleted ? openText(e.text, e.roomId, senderId) : null;
        updateMessage(set, e.roomId, e.messageId, {
          ...(opened ? decryptedFields(opened) : e.text !== undefined ? { text: e.text } : {}),
          ...(e.editedAt ? { editedAt: e.editedAt } : {}),
          ...(e.isDeleted ? { isDeleted: true, text: '', mediaUrl: undefined } : {}),
        });
        state.loadConversations().catch(() => undefined);
      }
      break;
    case 'reactions_updated':
      if (e.roomId && e.messageId) {
        updateMessage(set, e.roomId, e.messageId, {
          reactions: (e.reactions || []).map((r: any) => ({ emoji: r.emoji, userIds: r.userIds || r.user_ids || [] })),
        });
      }
      break;
    case 'conversation_prefs':
      if (e.conversationId) {
        state.setPrefs(e.conversationId, {
          ...('mutedUntil' in e ? { mutedUntil: e.mutedUntil } : {}),
          ...('isArchived' in e ? { isArchived: e.isArchived } : {}),
        });
      }
      break;
    case 'block_changed':
      if (e.userId) state.setBlocked(e.userId, !!e.blocked);
      break;
    case 'conversation_pinned':
      if (e.conversationId) state.setPinned(e.conversationId, !!e.pinned);
      break;
    case 'e2e_envelope':
      if (typeof e.deviceId === 'number' && e.envelope) {
        const meta: EnvelopeMeta | undefined = e.meta;
        receiveLive(e.deviceId, e.envelope, showLater).then((r) => {
          if (!r) return;
          // With its details (a new message): it enters the chat now. Without (edits, resends): fills a row
          if (meta) showEnvelope(r, meta);
          else applyV2(r);
        }).catch(() => undefined);
      }
      break;
    case 'expense_reminder':
      // Someone in a chat reminded us that we owe them (the push notification covers the app being closed)
      if (typeof e.text === 'string') showAlert('Payment reminder', e.text);
      break;
    case 'e2e_device_list':
      forgetDirectory(e.userId).catch(() => undefined);
      encryptionListeners.forEach((l) => l());
      break;
    case 'keys_changed':
      // Someone set up or reset their encryption keys
      e2eService.forgetUser(e.userId);
      encryptionListeners.forEach((l) => l());
      if (e.userId && e.userId === e2eSession.userId()) e2eSession.reportStale(); // ours, reset on another device
      break;
    case 'conversation_updated':
      if (e.conversationId) e2eService.forgetConversation(e.conversationId);
      forgetDirectory().catch(() => undefined); // members may have changed
      encryptionListeners.forEach((l) => l());
      state.loadConversations().catch(() => undefined);
      break;
    case 'conversation_created':
    case 'conversation_removed':
      state.loadConversations().catch(() => undefined);
      break;
  }
  extras.forEach((listener) => listener(e));
});

/** Someone's keys or a chat's members changed: open chats check their encryption again. */
const encryptionListeners = new Set<() => void>();
export const onEncryptionChange = (listener: () => void) => {
  encryptionListeners.add(listener);
  return () => {
    encryptionListeners.delete(listener);
  };
};

/** Names of people typing in a chat right now. */
export const typingNames = (typing: ChatState['typing'], conversationId: string) =>
  Object.values(typing[conversationId] || {})
    .filter((t) => t.until > Date.now())
    .map((t) => t.name || 'Someone');
