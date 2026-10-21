// Encrypting outgoing messages and decrypting incoming ones, on top of the shared core (e2e.ts).
// Shared word for word by web/src/crypto/messages.ts and mobile/src/crypto/messages.ts (each app
// has its own ./session and ../services/e2e.service with the same interface).
//
// The Redux store always holds the readable text: messages are decrypted as they arrive (REST pages,
// WebSocket events, chat-list previews) and encrypted right before they're sent.

import { isEncryptedText, openMessage, publicKeysOf, sealMessage } from './e2e';
import type { E2EMedia, E2EPayload, Recipient } from './e2e';
import { e2eSession } from './session';
import { e2eService } from '../services/e2e.service';

export const UNREADABLE_TEXT = "This message can't be decrypted on this device";
const LINK_RE = /https?:\/\/\S/i;

export interface Decrypted {
  ok: boolean;
  text: string;
  media?: E2EMedia;
  hasLink?: boolean;
  senderSignKey?: string;
}

// Decrypting is cheap, but chat lists and re-renders ask for the same envelopes again and again
const cache = new Map<string, Decrypted>();
const CACHE_LIMIT = 3000;

/** Decrypt a message's text if it's an encrypted envelope; null if it's a plain message. */
export function openText(text: string | null | undefined, conversationId: string, senderId: string): Decrypted | null {
  if (!text || !isEncryptedText(text)) return null;
  const keys = e2eSession.keys();
  const me = e2eSession.userId();
  if (!keys || !me) return { ok: false, text: '' };
  const cacheKey = `${me}|${conversationId}|${senderId}|${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  let result: Decrypted;
  try {
    const opened = openMessage(text, { conversationId, senderId, myId: me }, keys);
    result = { ok: true, text: opened.payload.t || '', media: opened.payload.m, hasLink: opened.payload.l, senderSignKey: opened.senderSignKey };
  } catch {
    // Sent before we joined, sealed for keys we've since reset, or altered
    result = { ok: false, text: '' };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, result);
  return result;
}

/** Fields a decrypted message adds to (or replaces in) a chat message. */
export function decryptedFields(d: Decrypted) {
  return {
    text: d.text,
    e2e: d.ok ? ('encrypted' as const) : ('unreadable' as const),
    senderSignKey: d.senderSignKey,
    ...(d.media
      ? {
          mediaKey: d.media.key,
          mediaMime: d.media.mime,
          thumbKey: d.media.tk,
          mediaFilename: d.media.name,
          mediaSize: d.media.size,
          mediaWidth: d.media.w,
          mediaHeight: d.media.h,
          mediaDuration: d.media.d,
        }
      : {}),
  };
}

interface Decryptable {
  conversationId: string;
  senderId: string;
  text: string;
  replyTo?: { text?: string; senderId?: string } | null;
}

/** A chat message with its envelope (and its reply's quoted envelope) replaced by readable content. */
export function decryptMessage<M extends Decryptable>(m: M): M {
  let out: M = m;
  const d = openText(m.text, m.conversationId, m.senderId);
  if (d) out = { ...out, ...decryptedFields(d) };
  if (m.replyTo?.text && m.replyTo.senderId) {
    const q = openText(m.replyTo.text, m.conversationId, m.replyTo.senderId);
    if (q) out = { ...out, replyTo: { ...m.replyTo, text: q.ok ? q.text || mediaLabel(q.media) : UNREADABLE_TEXT } };
  }
  return out;
}

export const mediaLabel = (media?: { type?: string; name?: string }): string => {
  if (!media) return '';
  if (media.type === 'image') return 'Photo';
  if (media.type === 'video') return 'Video';
  if (media.type === 'audio') return 'Voice message';
  return media.name || 'Document';
};

/** Chat-list preview of a last message that may be encrypted. */
export function previewText(text: string | undefined, conversationId: string, senderId?: string | null): string {
  if (!text || !senderId) return text || '';
  const d = openText(text, conversationId, senderId);
  if (!d) return text;
  if (!d.ok) return 'Encrypted message';
  return d.text || mediaLabel(d.media);
}

/**
 * Who to encrypt for in this chat, or null when it can't be end-to-end encrypted yet (someone in it
 * hasn't set up encryption). Throws if this browser's keys are out of date (reset on another device).
 */
export async function recipientsFor(conversationId: string): Promise<Recipient[] | null> {
  const keys = e2eSession.keys();
  const me = e2eSession.userId();
  if (!keys || !me) return null;
  const chat = await e2eService.conversationKeys(conversationId);
  if ((chat.v1_missing ?? chat.missing).length) return null; // version 1 needs everyone's version 1 keys
  const mine = chat.members[me];
  if (!mine || mine.enc !== publicKeysOf(keys).enc) {
    // Our keys were reset elsewhere: messages sealed with these would be unreadable to us later
    e2eSession.reportStale();
    throw new Error('Your encryption keys changed on another device. Unlock again to keep chatting.');
  }
  return Object.entries(chat.members).map(([userId, k]) => ({ userId, enc: k.enc! }));
}

/** Why nothing is sent in a chat that isn't end-to-end encrypted yet (the server refuses it too). */
export const NOT_ENCRYPTED_TEXT = "This chat isn't end-to-end encrypted yet, so messages can't be sent in it.";

/** Encrypt a message for a chat, or null if this chat isn't end-to-end encrypted yet (then don't send it). */
export async function sealFor(conversationId: string, payload: E2EPayload): Promise<{ text: string; hasLink: boolean } | null> {
  const recipients = await recipientsFor(conversationId);
  if (!recipients) return null;
  const keys = e2eSession.keys()!;
  const hasLink = LINK_RE.test(payload.t || '');
  const text = sealMessage({ ...payload, ...(hasLink ? { l: true } : {}) }, { conversationId, senderId: e2eSession.userId()! }, recipients, keys);
  return { text, hasLink };
}

/**
 * Check that encrypted messages were signed with their sender's own key (current or earlier).
 * Returns the ids of messages that fail, which the chat marks as unverified.
 */
export async function unverifiedMessages(messages: { id: string; senderId: string; senderSignKey?: string }[]): Promise<string[]> {
  const signed = messages.filter((m) => m.senderSignKey);
  if (!signed.length) return [];
  const keys = await e2eService.userKeys(signed.map((m) => m.senderId));
  return signed
    .filter((m) => {
      const k = keys[m.senderId];
      return !k || (k.sign !== m.senderSignKey && !k.previous_sign.includes(m.senderSignKey!));
    })
    .map((m) => m.id);
}
