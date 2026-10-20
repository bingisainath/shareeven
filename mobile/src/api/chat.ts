// src/api/chat.ts
import { api, data } from './client';
import { decryptMessage, previewText } from '../crypto/messages';

export interface Conversation {
  id: string;
  name: string;
  avatar?: string | null;
  lastMessage: string;
  lastMessageTime: string | null;
  lastMessageSenderId?: string | null;
  unreadCount: number;
  isGroup: boolean;
  members: string[];
  isPinned: boolean;
  pinnedAt: string | null;
  mutedUntil?: string | null; // muted for you until then (no notifications)
  isArchived?: boolean; // archived by you
  otherUserId?: string | null; // direct chats: the other person
  isBlocked?: boolean; // direct chats: you blocked the other person
}

/** Muted right now? */
export const isMuted = (c?: { mutedUntil?: string | null } | null) => !!c?.mutedUntil && new Date(c.mutedUntil).getTime() > Date.now();

export type MuteDuration = '8h' | '1w' | 'always';

export interface ServerSearchHit {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  isGroup: boolean;
  senderId: string | null;
  senderName: string | null;
  text: string;
  timestamp: string;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface ReplyPreview {
  id: string;
  text: string;
  senderId: string;
  senderName?: string | null;
  messageType?: string;
  isDeleted?: boolean;
}

export interface Message {
  id: string;
  clientId?: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  messageType?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'file';
  mediaFilename?: string;
  mediaSize?: number;
  mediaThumbnail?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number;
  uploadProgress?: number; // 0-100 while this phone uploads the attachment
  uploadFailed?: boolean; // upload failed: the bubble offers Retry / Remove
  isDeleted?: boolean;
  editedAt?: string | null;
  replyTo?: ReplyPreview | null;
  reactions: Reaction[];
  expenseId?: string | null;
  // End-to-end encryption (src/crypto): 'encrypted' = decrypted fine, 'unreadable' = not for this phone
  e2e?: 'encrypted' | 'unreadable' | 'pending'; // pending: v2 content not decrypted on this phone (yet)
  e2eVersion?: 2;
  localId?: string; // v2: the sender's message id (key in the phone's local database)
  mediaV2?: { sha256: string; size: number };
  thumbV2?: { sha256: string; size: number };
  mediaBlur?: string; // v2: tiny base64 JPEG shown blurred until the photo is decrypted
  e2eUnverified?: boolean; // signed with a key that isn't the sender's
  senderSignKey?: string;
  mediaKey?: string;
  mediaMime?: string;
  thumbKey?: string;
}

export interface MemberInfo {
  id: string;
  username: string;
  name?: string | null;
  avatar?: string | null;
  bio?: string | null;
  role: 'admin' | 'moderator' | 'member' | 'viewer';
  is_me: boolean;
}

export interface ConversationDetails {
  id: string;
  kind: 'dm' | 'group';
  title?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  my_role: MemberInfo['role'];
  members: MemberInfo[];
}

export interface UserSummary {
  id: string;
  username: string;
  name?: string;
  avatar?: string | null;
}

/** API message (snake_case) -> app message */
// v2 rows only say "a message was sent"; the content is filled from the phone's local database
const markV2 = (m: Message): Message => (typeof m.text === 'string' && m.text.startsWith('e2e2:') ? { ...m, text: '', e2e: 'pending', e2eVersion: 2 } : m);

export const toMessage = (m: any): Message => markV2(decryptMessage({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  senderName: m.sender?.username,
  senderAvatar: m.sender?.avatar,
  text: m.text || '',
  timestamp: m.created_at,
  status: m.status || 'delivered',
  messageType: m.message_type,
  mediaUrl: m.media_url || undefined,
  mediaType: m.media_type || undefined,
  mediaFilename: m.media_filename || undefined,
  mediaSize: m.media_size || undefined,
  mediaThumbnail: m.media_thumbnail || undefined,
  mediaWidth: m.media_width || undefined,
  mediaHeight: m.media_height || undefined,
  mediaDuration: m.media_duration || undefined,
  isDeleted: !!m.is_deleted,
  editedAt: m.edited_at || null,
  replyTo: m.reply_to
    ? {
        id: m.reply_to.id,
        text: m.reply_to.text,
        senderId: m.reply_to.sender_id,
        senderName: m.reply_to.sender_name,
        messageType: m.reply_to.message_type,
        isDeleted: m.reply_to.is_deleted,
      }
    : null,
  reactions: (m.reactions || []).map((r: any) => ({ emoji: r.emoji, userIds: r.user_ids || r.userIds || [] })),
  expenseId: m.expense_id || null,
} as Message));

export const chatApi = {
  // Last-message previews of encrypted chats are decrypted here
  conversations: async () =>
    (await data<Conversation[]>(api.get('/conversations'))).map((c) => ({
      ...c,
      lastMessage: previewText(c.lastMessage, c.id, c.lastMessageSenderId),
    })),
  messages: async (conversationId: string, before?: string) => {
    const r = await api.get(`/conversations/${conversationId}/messages`, { params: { limit: 50, before } });
    return { messages: (r.data.data as any[]).map(toMessage), hasMore: !!r.data.has_more };
  },
  markRead: (conversationId: string) => api.post(`/conversations/${conversationId}/mark-read`),
  details: (conversationId: string) => data<ConversationDetails>(api.get(`/conversations/${conversationId}`)),
  createDm: (userId: string) => data<{ id: string }>(api.post('/conversations', { kind: 'dm', participant_ids: [userId] })),
  createGroup: (title: string, memberIds: string[]) =>
    data<{ id: string }>(api.post('/conversations', { kind: 'group', title, participant_ids: memberIds })),
  searchUsers: (search: string) => data<UserSummary[]>(api.get('/users', { params: { search } })),
  pin: (conversationId: string, pinned: boolean) => api.put(`/conversations/${conversationId}/pin`, { pinned }),
  mute: (conversationId: string, duration: MuteDuration | null) =>
    api.put(`/conversations/${conversationId}/mute`, { duration }).then((r) => r.data.data as { mutedUntil: string | null }),
  archive: (conversationId: string, archived: boolean) => api.put(`/conversations/${conversationId}/archive`, { archived }),
  /** Message text the server can read (not end-to-end encrypted chats). */
  search: (q: string, conversationId?: string) =>
    api.get('/messages/search', { params: { q, ...(conversationId ? { conversation_id: conversationId } : {}) } }).then((r) => r.data.data as ServerSearchHit[]),
  /** hasLink: encrypted edits tell the server whether there's a link (for the Links tab) */
  editMessage: (messageId: string, text: string, hasLink?: boolean) => api.patch(`/messages/${messageId}`, { text, has_link: !!hasLink }),
  deleteMessage: (messageId: string) => api.delete(`/messages/${messageId}`),
  /** Toggle your reaction (same emoji again removes it) */
  react: (messageId: string, emoji: string) => api.put(`/messages/${messageId}/reaction`, { emoji }),
  addMembers: (conversationId: string, userIds: string[]) => api.post(`/conversations/${conversationId}/members`, { user_ids: userIds }),
  removeMember: (conversationId: string, userId: string) => api.delete(`/conversations/${conversationId}/members/${userId}`),
  /** Group admins: rename, describe or change the photo ('' removes the description or photo) */
  updateGroup: (conversationId: string, body: { title?: string; description?: string; avatar_url?: string }) =>
    api.patch(`/conversations/${conversationId}`, body),
  /** Leaving a group = removing yourself */
  leave: (conversationId: string, myId: string) => api.delete(`/conversations/${conversationId}/members/${myId}`),
};
