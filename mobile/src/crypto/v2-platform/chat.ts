// src/crypto/v2-platform/chat.ts
// Encryption v2 in the phone's chat screens (phase 4), same rules as web/src/crypto/v2-platform/chat.ts:
// a conversation uses v2 once every member has a v2 device list and this phone is on its account's
// list; otherwise sending stays on v1 as before.

import { createThumbnail } from 'react-native-create-thumbnail';
import { api } from '../../api/client';
import { uploadFile } from '../../api/media';
import type { LocalFile } from '../../api/media';
import type { Message, ReplyPreview } from '../../api/chat';
import { socket } from '../../websocket/socket';
import { isV2Marker, LocalMessage, MediaPointer, MessageBody } from '../v2';
import type { Address, IncomingEnvelope, OutgoingEnvelope, Received } from '../v2';
import { encryptFileV2, rememberDecrypted } from '../media';
import { blurPreview } from '../../utils/blurPreview';
import { v2Runtime } from './runtime';

const LINK_RE = /https?:\/\/\S/i;

export { isV2Marker };

export interface ChatInfo { conversationId: string; isGroup: boolean; members: string[] }
type V2 = NonNullable<Awaited<ReturnType<typeof v2For>>>;

export async function v2For(chat: ChatInfo) {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime?.state.listed || !chat.members.length) return null;
  const members = Array.from(new Set([...chat.members, runtime.userId]));
  return (await runtime.messenger.ready(members).catch(() => false)) ? { runtime, members } : null;
}

const typeOf = (p: MediaPointer): Message['mediaType'] => p.type || (p.mime.startsWith('image/') ? 'image' : p.mime.startsWith('video/') ? 'video' : p.mime.startsWith('audio/') ? 'audio' : 'file');

/** When a chat opens: fetch and check its members' device lists now, so the first message sends quickly. */
export function warmChat(chat: ChatInfo): void {
  v2For(chat).catch(() => undefined);
}

// The preview is whatever the sender put there: only a short base64 string is shown
const safeBlur = (b: unknown): string | undefined => (typeof b === 'string' && b.length <= 4000 && /^[A-Za-z0-9+/]+=*$/.test(b) ? b : undefined);

export function fromLocal(m: LocalMessage): Partial<Message> {
  const p = m.media?.[0];
  return {
    text: m.deleted ? '' : m.text || '',
    e2e: 'encrypted',
    e2eVersion: 2,
    localId: m.id,
    isDeleted: m.deleted || undefined,
    editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : undefined,
    ...(p ? {
      mediaType: typeOf(p), mediaKey: p.key, mediaMime: p.mime, mediaFilename: p.name, mediaSize: p.size,
      mediaWidth: p.w, mediaHeight: p.h, mediaDuration: p.dur, mediaV2: { sha256: p.sha256, size: p.size }, mediaBlur: safeBlur(p.blur),
      ...(p.thumb ? { thumbKey: p.thumb.key, thumbV2: { sha256: p.thumb.sha256, size: p.thumb.size } } : {}),
    } : {}),
  };
}

export const pendingFields: Partial<Message> = { text: '', e2e: 'pending', e2eVersion: 2 };

export async function localFor(serverId: string): Promise<LocalMessage | null> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.messenger.byServerId(serverId) : null;
}

/**
 * When this phone joined the account's devices (0 if unknown). Messages sent before then were never
 * encrypted for it: unless the history brought them, they can't be read here.
 */
export async function joinedAt(): Promise<number> {
  const runtime = await v2Runtime()?.catch(() => null);
  return (runtime && (await runtime.store.setting<number>('joinedAt'))) || 0;
}

/** Search this phone's encrypted message database (end-to-end encrypted chats). */
export async function searchLocal(query: string, conversationId?: string): Promise<LocalMessage[]> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.store.searchMessages(query, { conv: conversationId }) : [];
}

export async function lastLocal(conversationId: string): Promise<LocalMessage | null> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.store.lastMessage(conversationId) : null;
}

interface SendExtra { attachments?: string[]; replyToId?: string; hasLink?: boolean }

// Sends the server hasn't confirmed yet, kept so a "devices changed" answer can encrypt them again
const unconfirmed = new Map<string, { chat: ChatInfo; messageType: string; extra: SendExtra; body: MessageBody; resent: boolean }>();

function sendOverSocket(chat: ChatInfo, clientId: string, deviceId: number, messageType: string, envelopes: OutgoingEnvelope[], extra: SendExtra, body: MessageBody) {
  unconfirmed.set(clientId, { chat, messageType, extra, body, resent: false });
  return socket.send({
    type: 'message_v2', roomId: chat.conversationId, clientId, fromDevice: deviceId, messageType,
    envelopes, attachments: extra.attachments || [], ...(extra.replyToId ? { replyToId: extra.replyToId } : {}), hasLink: !!extra.hasLink,
  });
}

/**
 * The server refused a message because someone's devices changed since we fetched their lists (a new
 * phone was linked, one logged out): fetch the lists again and encrypt it once more, like Signal does.
 * False if it can't be resent; the message is then shown as failed.
 */
export async function resendAfterDevicesChanged(clientId: string, users: string[]): Promise<boolean> {
  const pending = unconfirmed.get(clientId);
  if (!pending || pending.resent) return false;
  pending.resent = true;
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime) return false;
  users.forEach((user) => runtime.messenger.forget(user));
  const v2 = await v2For(pending.chat);
  if (!v2) return false;
  const envelopes = await v2.runtime.messenger.encrypt(pending.chat.conversationId, pending.chat.isGroup, v2.members, pending.body);
  return socket.send({
    type: 'message_v2', roomId: pending.chat.conversationId, clientId, fromDevice: v2.runtime.state.deviceId, messageType: pending.messageType,
    envelopes, attachments: pending.extra.attachments || [], ...(pending.extra.replyToId ? { replyToId: pending.extra.replyToId } : {}),
    hasLink: !!pending.extra.hasLink,
  });
}

/** This phone's device number (null before encryption v2 has started). */
export async function myDeviceId(): Promise<number | null> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.state.deviceId : null;
}

/** This phone couldn't decrypt a message: ask the device that sent it to encrypt it again. */
export async function askAgain(messageId: string, senderDevice: number): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime) return;
  await api.post('/e2e/v2/retry-requests', { device_id: runtime.state.deviceId, message_id: messageId, sender_device: senderDevice }).catch(() => undefined);
}

export interface RetryRequest { id: string; message_id: string; conversation_id: string; requester: Address; sender_device: number }

/** Another device asked for one of our messages again: encrypt it for that device only. */
export async function answerRetry(request: RetryRequest): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime || request.sender_device !== runtime.state.deviceId) return;
  const envelope = await runtime.messenger.resend(request.message_id, request.requester).catch(() => null);
  if (envelope) {
    await api.post(`/e2e/v2/conversations/${request.conversation_id}/envelopes`, {
      from_device: runtime.state.deviceId, message_id: request.message_id, packets: [envelope],
    }).catch(() => undefined);
  }
  await api.post(`/e2e/v2/retry-requests/${request.id}/done`).catch(() => undefined);
}

/** Requests that came while this phone was away (after connecting). */
export async function answerWaitingRetries(): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime) return;
  const r = await api.get(`/e2e/v2/retry-requests/${runtime.state.deviceId}`).catch(() => null);
  for (const request of (r?.data?.data || []) as RetryRequest[]) await answerRetry(request);
}

const me = (v2: V2) => ({ user: v2.runtime.userId, device: v2.runtime.state.deviceId });

export async function sendTextV2(v2: V2, chat: ChatInfo, clientId: string, text: string, replyTo?: ReplyPreview | null): Promise<boolean> {
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: 'text', text, ...(replyTo ? { replyTo: replyTo.id } : {}) };
  const envelopes = await v2.runtime.messenger.encrypt(chat.conversationId, chat.isGroup, v2.members, body);
  await v2.runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: me(v2), ts: body.ts, kind: 'text', text, replyTo: body.replyTo, status: 'sending' });
  return sendOverSocket(chat, clientId, v2.runtime.state.deviceId, 'text', envelopes, { replyToId: replyTo?.id, hasLink: LINK_RE.test(text) }, body);
}

async function uploadV2(file: { uri: string; type: string }, kind: 'image' | 'video' | 'audio' | 'file', onProgress?: (p: number) => void, signal?: AbortSignal) {
  const sealed = await encryptFileV2(file);
  const uploaded = await uploadFile({ uri: sealed.uri, type: 'application/octet-stream', name: 'file.enc' }, { encrypted: kind, onProgress, signal });
  await rememberDecrypted(uploaded.url, sealed.key, file.uri, file.type);
  return { url: uploaded.url, key: sealed.key, sha256: sealed.sha256, size: sealed.size };
}

export async function sendMediaV2(
  v2: V2, chat: ChatInfo, clientId: string, file: LocalFile, kind: 'image' | 'video' | 'audio' | 'file', caption: string,
  options: { width?: number; height?: number; duration?: number; replyTo?: ReplyPreview | null; signal?: AbortSignal; onProgress?: (p: number) => void },
): Promise<{ sent: boolean; posterUri?: string; width?: number; height?: number }> {
  let thumb: MediaPointer['thumb'];
  let width = options.width;
  let height = options.height;
  let posterUri: string | undefined;
  let blur = kind === 'image' ? await blurPreview(file.uri) : undefined;
  if (kind === 'video') {
    try {
      const poster = await createThumbnail({ url: file.uri, timeStamp: 500, format: 'jpeg' });
      width = poster.width || width;
      height = poster.height || height;
      posterUri = poster.path;
      blur = await blurPreview(poster.path);
      const t = await uploadV2({ uri: poster.path, type: 'image/jpeg' }, 'image', undefined, options.signal);
      thumb = { url: t.url, key: t.key, sha256: t.sha256, size: t.size, mime: 'image/jpeg' };
    } catch {
      // no preview frame: the video still sends
    }
  }
  const main = await uploadV2(file, kind, options.onProgress, options.signal);
  const pointer: MediaPointer = {
    url: main.url, key: main.key, sha256: main.sha256, size: main.size, mime: file.type, type: kind, name: file.name,
    w: width, h: height, dur: options.duration, thumb, blur,
  };
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: 'media', text: caption, media: [pointer], ...(options.replyTo ? { replyTo: options.replyTo.id } : {}) };
  const envelopes = await v2.runtime.messenger.encrypt(chat.conversationId, chat.isGroup, v2.members, body);
  await v2.runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: me(v2), ts: body.ts, kind: 'media', text: caption, media: [pointer], replyTo: body.replyTo, status: 'sending' });
  const sent = sendOverSocket(chat, clientId, v2.runtime.state.deviceId, kind, envelopes, {
    attachments: [main.url, ...(thumb ? [thumb.url] : [])], replyToId: options.replyTo?.id, hasLink: LINK_RE.test(caption),
  }, body);
  return { sent, posterUri, width, height };
}

export async function forwardV2(v2: V2, chat: ChatInfo, clientId: string, text: string, pointer?: MediaPointer): Promise<boolean> {
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: pointer ? 'media' : 'text', text, ...(pointer ? { media: [pointer] } : {}) };
  const envelopes = await v2.runtime.messenger.encrypt(chat.conversationId, chat.isGroup, v2.members, body);
  await v2.runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: me(v2), ts: body.ts, kind: body.kind as 'text' | 'media', text, media: body.media, status: 'sending' });
  return sendOverSocket(chat, clientId, v2.runtime.state.deviceId, pointer ? (pointer.type || 'file') : 'text', envelopes, {
    attachments: pointer ? [pointer.url, ...(pointer.thumb ? [pointer.thumb.url] : [])] : [], hasLink: LINK_RE.test(text),
  }, body);
}

const plainUrl = (u: string) => u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');

export function pointerOf(m: Message): MediaPointer | undefined {
  if (m.e2eVersion !== 2 || !m.mediaKey || !m.mediaV2 || !m.mediaUrl) return undefined;
  return {
    url: plainUrl(m.mediaUrl), key: m.mediaKey, sha256: m.mediaV2.sha256, size: m.mediaV2.size,
    mime: m.mediaMime || 'application/octet-stream', type: m.mediaType, name: m.mediaFilename, w: m.mediaWidth, h: m.mediaHeight, dur: m.mediaDuration, blur: m.mediaBlur,
    ...(m.thumbKey && m.thumbV2 && m.mediaThumbnail ? { thumb: { url: plainUrl(m.mediaThumbnail), key: m.thumbKey, sha256: m.thumbV2.sha256, size: m.thumbV2.size, mime: 'image/jpeg' } } : {}),
  };
}

export async function editV2(chat: ChatInfo, message: Message, text: string): Promise<void> {
  const v2 = await v2For(chat);
  if (!v2 || !message.localId) throw new Error("Can't edit this message from this phone");
  const local = await v2.runtime.store.message(message.localId);
  const rev = (local?.rev ?? 0) + 1;
  const envelopes = await v2.runtime.messenger.encryptEdit(chat.conversationId, chat.isGroup, v2.members, message.localId, rev, text);
  await api.post(`/e2e/v2/conversations/${chat.conversationId}/envelopes`, {
    from_device: v2.runtime.state.deviceId, message_id: message.id.startsWith('temp-') ? undefined : message.id, packets: envelopes,
  });
  await v2.runtime.store.transaction((tx) => tx.editMessage(message.localId!, rev, text, Date.now()));
}

export async function confirmOwn(clientId: string, serverId: string): Promise<LocalMessage | null> {
  unconfirmed.delete(clientId);
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.messenger.confirmSent(clientId, serverId) : null;
}

// Live packets are opened one at a time, in the order they came. A group's first message follows
// the packet carrying its key; opened side by side (the key's packet is slower the first time two
// people talk), the message was tried first and stayed unread until the next reconnect.
let liveQueue: Promise<unknown> = Promise.resolve();
let somethingWaits = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_WAITING_MS = 15_000;

/**
 * `onLater`: packets that had to wait (for a group key, or because the server couldn't be reached)
 * and can be read now: when the key comes, or on a retry a little later.
 */
export function receiveLive(deviceId: number, envelope: IncomingEnvelope, onLater?: (r: Received) => void): Promise<Received | null> {
  const run = liveQueue.then(async () => {
    const runtime = await v2Runtime()?.catch(() => null);
    if (!runtime || deviceId !== runtime.state.deviceId) return null;
    const result = await runtime.messenger.receive(envelope);
    if (result.kind === 'waiting') {
      somethingWaits = true;
      if (onLater && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (somethingWaits) drainLive(onLater);
        }, RETRY_WAITING_MS);
      }
    } else {
      await runtime.messenger.ack([envelope.id]).catch(() => undefined);
    }
    if (result.kind === 'control' && somethingWaits && onLater) await drainNow(runtime, onLater);
    return result;
  });
  liveQueue = run.catch(() => undefined);
  return run;
}

async function drainNow(runtime: NonNullable<Awaited<ReturnType<typeof v2Runtime>>>, onReceived: (r: Received) => void) {
  somethingWaits = false;
  await runtime.messenger.drain((r, envelope) => {
    if (r.kind === 'waiting') somethingWaits = true;
    // Unreadable while we were away: ask the sender's device for it again, as for a live one
    if (r.kind === 'failed' && envelope.message_id) askAgain(envelope.message_id, envelope.from.device).catch(() => undefined);
    onReceived(r);
  }).catch(() => { somethingWaits = true; });
}

/** Process the mailbox in turn with live packets (so the same packet isn't opened twice at once). */
function drainLive(onReceived: (r: Received) => void): Promise<void> {
  const run = liveQueue.then(async () => {
    const runtime = await v2Runtime()?.catch(() => null);
    if (runtime?.state.listed) await drainNow(runtime, onReceived);
  });
  liveQueue = run.catch(() => undefined);
  return run;
}

export function drainMailbox(onReceived: (r: Received) => void): Promise<void> {
  return drainLive(onReceived);
}

export async function forgetDirectory(user?: string): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  runtime?.messenger.forget(user);
}
