// src/crypto/v2-platform/chat.ts
// Encryption v2 in the chat screens (phase 4): decides per conversation whether to send with v2,
// sends and receives through the Messenger, and turns local v2 messages into chat messages.
// A conversation uses v2 once every member has a v2 device list and this browser is on its
// account's list; otherwise sending stays on v1 (crypto/messages.ts) as before.

import api from '../../utils/axios';
import { mediaService } from '../../services/media.service';
import { wsService } from '../../services/websocket.service';
import { captureVideoPoster, compressImage, measureMedia, mediaTypeOf } from '../../utils/media';
import type { UploadQuality } from '../../utils/media';
import type { Message, ReplyPreview } from '../../redux/slices/chatSlice';
import { encryptMedia, isV2Marker, LocalMessage, MediaPointer, MessageBody } from '../v2';
import type { Address, IncomingEnvelope, OutgoingEnvelope, Received } from '../v2';
import { rememberDecrypted } from '../media';
import { jpegOrientation, stripJpegMetadata } from '../e2e';
import { v2Runtime } from './runtime';

const LINK_RE = /https?:\/\/\S/i;

export { isV2Marker };

export interface ChatInfo { conversationId: string; isGroup: boolean; members: string[] }

/** The running v2 messenger if this browser can send with v2 in this chat, else null. */
export async function v2For(chat: ChatInfo) {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime?.state.listed || !chat.members.length) return null;
  const members = Array.from(new Set([...chat.members, runtime.userId]));
  return (await runtime.messenger.ready(members).catch(() => false)) ? { runtime, members } : null;
}

const typeOf = (p: MediaPointer): Message['mediaType'] => p.type || (p.mime.startsWith('image/') ? 'image' : p.mime.startsWith('video/') ? 'video' : p.mime.startsWith('audio/') ? 'audio' : 'file');

/** Chat-message fields from a local v2 message (text, media pointer, reply, edit state). */
/** When a chat opens: fetch and check its members' device lists now, so the first message sends quickly. */
export function warmChat(chat: ChatInfo): void {
  v2For(chat).catch(() => undefined);
}

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
      mediaWidth: p.w, mediaHeight: p.h, mediaDuration: p.dur, mediaV2: { sha256: p.sha256, size: p.size },
      ...(p.thumb ? { thumbKey: p.thumb.key, thumbV2: { sha256: p.thumb.sha256, size: p.thumb.size } } : {}),
    } : {}),
  };
}

/** What a v2 timeline row shows until (or unless) this device can decrypt it. */
export const pendingFields: Partial<Message> = { text: '', e2e: 'pending', e2eVersion: 2 };

/** Fill a timeline row (server copy) from this device's local database, if it has it. */
export async function localFor(serverId: string): Promise<LocalMessage | null> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.messenger.byServerId(serverId) : null;
}

/**
 * When this browser joined the account's devices (0 if unknown). Messages sent before then were never
 * encrypted for it: unless the history brought them, they can't be read here.
 */
export async function joinedAt(): Promise<number> {
  const runtime = await v2Runtime()?.catch(() => null);
  return (runtime && (await runtime.store.setting<number>('joinedAt'))) || 0;
}

/** Search this browser's encrypted message database (end-to-end encrypted chats). */
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
  return wsService.sendEvent({
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
  return wsService.sendEvent({
    type: 'message_v2', roomId: pending.chat.conversationId, clientId, fromDevice: v2.runtime.state.deviceId, messageType: pending.messageType,
    envelopes, attachments: pending.extra.attachments || [], ...(pending.extra.replyToId ? { replyToId: pending.extra.replyToId } : {}),
    hasLink: !!pending.extra.hasLink,
  });
}

/** This browser's device number (null before encryption v2 has started). */
export async function myDeviceId(): Promise<number | null> {
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.state.deviceId : null;
}

/** This browser couldn't decrypt a message: ask the device that sent it to encrypt it again. */
export async function askAgain(messageId: string, senderDevice: number): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime) return;
  await api.post('/api/v1/e2e/v2/retry-requests', { device_id: runtime.state.deviceId, message_id: messageId, sender_device: senderDevice }).catch(() => undefined);
}

export interface RetryRequest { id: string; message_id: string; conversation_id: string; requester: Address; sender_device: number }

/** Another device asked for one of our messages again: encrypt it for that device only. */
export async function answerRetry(request: RetryRequest): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime || request.sender_device !== runtime.state.deviceId) return;
  const envelope = await runtime.messenger.resend(request.message_id, request.requester).catch(() => null);
  if (envelope) {
    await api.post(`/api/v1/e2e/v2/conversations/${request.conversation_id}/envelopes`, {
      from_device: runtime.state.deviceId, message_id: request.message_id, packets: [envelope],
    }).catch(() => undefined);
  }
  await api.post(`/api/v1/e2e/v2/retry-requests/${request.id}/done`).catch(() => undefined);
}

/** Requests that came while this browser was away (after connecting). */
export async function answerWaitingRetries(): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  if (!runtime) return;
  const r = await api.get(`/api/v1/e2e/v2/retry-requests/${runtime.state.deviceId}`).catch(() => null);
  for (const request of (r?.data?.data || []) as RetryRequest[]) await answerRetry(request);
}

/** Send a text message with v2. Returns false if the socket is down. */
export async function sendTextV2(v2: NonNullable<Awaited<ReturnType<typeof v2For>>>, chat: ChatInfo, clientId: string, text: string, replyTo?: ReplyPreview | null): Promise<boolean> {
  const { runtime, members } = v2;
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: 'text', text, ...(replyTo ? { replyTo: replyTo.id } : {}) };
  const envelopes = await runtime.messenger.encrypt(chat.conversationId, chat.isGroup, members, body);
  await runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: { user: runtime.userId, device: runtime.state.deviceId }, ts: body.ts, kind: 'text', text, replyTo: body.replyTo, status: 'sending' });
  return sendOverSocket(chat, clientId, runtime.state.deviceId, 'text', envelopes, { replyToId: replyTo?.id, hasLink: LINK_RE.test(text) }, body);
}

/** Encrypt a file (PMV2) and upload it. */
async function uploadV2(file: Blob, kind: 'image' | 'video' | 'audio' | 'file', onProgress?: (p: number) => void, signal?: AbortSignal) {
  let data = new Uint8Array(await file.arrayBuffer());
  // Photos sent as documents aren't re-drawn, so drop their location/camera data here (as version 1 did).
  // Only when upright already: rotated photos keep their EXIF so they don't display sideways.
  if (file.type === 'image/jpeg' && jpegOrientation(data) === 1) data = stripJpegMetadata(data);
  const sealed = encryptMedia(data);
  const uploaded = await mediaService.upload(new File([sealed.blob], 'file.enc', { type: 'application/octet-stream' }), onProgress, { signal, encrypted: kind });
  return { url: uploaded.url, key: sealed.key, sha256: sealed.sha256, size: sealed.size };
}

/** Send a photo, video, voice note or document with v2. */
export async function sendMediaV2(
  v2: NonNullable<Awaited<ReturnType<typeof v2For>>>, chat: ChatInfo, clientId: string, file: File, caption: string,
  options: { quality?: UploadQuality; duration?: number; replyTo?: ReplyPreview | null; signal?: AbortSignal; onProgress?: (p: number) => void },
): Promise<boolean> {
  const { runtime, members } = v2;
  const quality = options.quality || 'standard';
  const kind = quality === 'original' && mediaTypeOf(file) !== 'audio' ? 'file' : mediaTypeOf(file);
  const prepared = kind === 'image' ? await compressImage(file, quality) : file;
  const [dims, poster] = await Promise.all([
    kind === 'image' || kind === 'video' ? measureMedia(file) : Promise.resolve(null),
    kind === 'video' ? captureVideoPoster(file) : Promise.resolve(null),
  ]);
  const main = await uploadV2(prepared, kind, options.onProgress, options.signal);
  rememberDecrypted(main.url, main.key, prepared);
  let thumb: MediaPointer['thumb'];
  if (poster) {
    const t = await uploadV2(poster, 'image', undefined, options.signal);
    rememberDecrypted(t.url, t.key, poster);
    thumb = { url: t.url, key: t.key, sha256: t.sha256, size: t.size, mime: 'image/jpeg' };
  }
  const pointer: MediaPointer = {
    url: main.url, key: main.key, sha256: main.sha256, size: main.size, mime: prepared.type || 'application/octet-stream', type: kind,
    name: (prepared as File).name || file.name, w: dims?.width, h: dims?.height, dur: options.duration, thumb,
  };
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: 'media', text: caption, media: [pointer], ...(options.replyTo ? { replyTo: options.replyTo.id } : {}) };
  const envelopes = await runtime.messenger.encrypt(chat.conversationId, chat.isGroup, members, body);
  await runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: { user: runtime.userId, device: runtime.state.deviceId }, ts: body.ts, kind: 'media', text: caption, media: [pointer], replyTo: body.replyTo, status: 'sending' });
  return sendOverSocket(chat, clientId, runtime.state.deviceId, kind, envelopes, {
    attachments: [main.url, ...(thumb ? [thumb.url] : [])], replyToId: options.replyTo?.id, hasLink: LINK_RE.test(caption),
  }, body);
}

/** Forward an existing v2 or plain message into a v2 chat (files are reused: only their key is sealed again). */
export async function forwardV2(v2: NonNullable<Awaited<ReturnType<typeof v2For>>>, chat: ChatInfo, clientId: string, text: string, pointer?: MediaPointer): Promise<boolean> {
  const { runtime, members } = v2;
  const body: MessageBody = { v: 2, id: clientId, conv: chat.conversationId, ts: Date.now(), kind: pointer ? 'media' : 'text', text, ...(pointer ? { media: [pointer] } : {}) };
  const envelopes = await runtime.messenger.encrypt(chat.conversationId, chat.isGroup, members, body);
  await runtime.messenger.rememberSent({ id: clientId, conv: chat.conversationId, sender: { user: runtime.userId, device: runtime.state.deviceId }, ts: body.ts, kind: body.kind as 'text' | 'media', text, media: body.media, status: 'sending' });
  return sendOverSocket(chat, clientId, runtime.state.deviceId, pointer ? (pointer.type || 'file') : 'text', envelopes, {
    attachments: pointer ? [pointer.url, ...(pointer.thumb ? [pointer.thumb.url] : [])] : [], hasLink: LINK_RE.test(text),
  }, body);
}

/** The v2 media pointer of a chat message (to forward it). */
export function pointerOf(m: Message): MediaPointer | undefined {
  if (m.e2eVersion !== 2 || !m.mediaKey || !m.mediaV2 || !m.mediaUrl) return undefined;
  return {
    url: m.mediaUrl.split('?')[0].replace(/^https?:\/\/[^/]+/, ''), key: m.mediaKey, sha256: m.mediaV2.sha256, size: m.mediaV2.size,
    mime: m.mediaMime || 'application/octet-stream', type: m.mediaType, name: m.mediaFilename, w: m.mediaWidth, h: m.mediaHeight, dur: m.mediaDuration,
    ...(m.thumbKey && m.thumbV2 && m.mediaThumbnail ? { thumb: { url: m.mediaThumbnail.split('?')[0].replace(/^https?:\/\/[^/]+/, ''), key: m.thumbKey, sha256: m.thumbV2.sha256, size: m.thumbV2.size, mime: 'image/jpeg' } } : {}),
  };
}

/** Edit a v2 message: a follow-up packet to the same devices (the timeline row stays as it is). */
export async function editV2(chat: ChatInfo, message: Message, text: string): Promise<void> {
  const v2 = await v2For(chat);
  if (!v2 || !message.localId) throw new Error("Can't edit this message from this browser");
  const local = await v2.runtime.store.message(message.localId);
  const rev = (local?.rev ?? 0) + 1;
  const envelopes = await v2.runtime.messenger.encryptEdit(chat.conversationId, chat.isGroup, v2.members, message.localId, rev, text);
  await api.post(`/api/v1/e2e/v2/conversations/${chat.conversationId}/envelopes`, {
    from_device: v2.runtime.state.deviceId, message_id: message.id.startsWith('temp-') ? undefined : message.id, packets: envelopes,
  });
  await v2.runtime.store.transaction((tx) => tx.editMessage(message.localId!, rev, text, Date.now()));
}

/** Our message came back from the server: link our local copy to the timeline row. */
export async function confirmOwn(clientId: string, serverId: string): Promise<LocalMessage | null> {
  unconfirmed.delete(clientId);
  const runtime = await v2Runtime()?.catch(() => null);
  return runtime ? runtime.messenger.confirmSent(clientId, serverId) : null;
}

/** Process one envelope that arrived over the WebSocket (if it's for this browser). */
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

/** Process everything waiting in this browser's mailbox (after starting or reconnecting). */
export function drainMailbox(onReceived: (r: Received) => void): Promise<void> {
  return drainLive(onReceived);
}

/** A device list or a chat's members changed. */
export async function forgetDirectory(user?: string): Promise<void> {
  const runtime = await v2Runtime()?.catch(() => null);
  runtime?.messenger.forget(user);
}
