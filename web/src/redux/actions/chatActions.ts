// src/redux/actions/chatActions.ts

import { AppDispatch, RootState } from '../store';
import { chatService } from '../../services/chat.service';
import { parseApiError } from '../../utils/apiError';
import { toast } from 'react-toastify';
import {
  setConversations,
  setMessages,
  prependMessages,
  setPinned, setConversationPrefs,
  setLoading,
  setMessagesLoading,
  setError,
  addConversation,
  updateMessage,
  updateConversationLastMessage,
} from '../slices/chatSlice';
import { decryptMessage, previewText, unverifiedMessages } from '../../crypto/messages';
import { fromLocal, isV2Marker, joinedAt, lastLocal, localFor, pendingFields, warmChat } from '../../crypto/v2-platform/chat';
import type { Message } from '../slices/chatSlice';

/**
 * Fetch all conversations
 */
export const fetchConversations = () => async (dispatch: AppDispatch, getState: () => RootState) => {
  try {
    dispatch(setLoading(true));

    const response = await chatService.getConversations();

    if (response.success && response.data) {

      const state = getState();
      const onlineUsers = state.websocket.onlineUsers || [];
      const currentUserId = localStorage.getItem('userId');


      const conversationsWithOnline = response.data.map((conv: any) => {
        let isOnline = false;

        if (!conv.isGroup && conv.members && Array.isArray(conv.members)) {
          // ✅ Find the OTHER user (not current user)
          const otherUserId = conv.members.find((id: string) => id !== currentUserId);

          // ✅ Check if OTHER user is online (exclude current user from check)
          isOnline = !!(
            otherUserId &&
            otherUserId !== currentUserId &&  // Double-check it's not current user
            onlineUsers.includes(otherUserId)
          );

        }


        

        // The open chat is being read live (if the tab is visible); its read receipt may still be in flight
        const isActive =
          conv.id === (window as any).__activeConversationId && document.visibilityState === 'visible';

        return {
          ...conv,
          lastMessage: previewText(conv.lastMessage, conv.id, conv.lastMessageSenderId),
          isOnline,
          members: conv.members || [],
          unreadCount: isActive ? 0 : conv.unreadCount || 0,
        };
      });

      dispatch(setConversations(conversationsWithOnline));

      // v2 chats: the server only knows a message was sent; the preview comes from this device's copy
      conversationsWithOnline.filter((c: any) => isV2Marker(c.lastMessage)).forEach((c: any) => {
        dispatch(updateConversationLastMessage({ conversationId: c.id, lastMessage: 'Encrypted message', timestamp: c.lastMessageTime }));
        lastLocal(c.id).then((m) => {
          if (!m) return;
          const f = fromLocal(m);
          dispatch(updateConversationLastMessage({ conversationId: c.id, lastMessage: f.text || (f.mediaType === 'image' ? 'Photo' : f.mediaType === 'video' ? 'Video' : f.mediaType === 'audio' ? 'Voice message' : f.mediaFilename || 'File'), timestamp: c.lastMessageTime }));
        }).catch(() => undefined);
      });


    }
  } catch (error: any) {
    console.error('Failed to fetch conversations:', error);
    dispatch(setError(error.message || 'Failed to load conversations'));
  } finally {
    dispatch(setLoading(false));
  }
};

const toMessage = (msg: any) => (isV2Marker(msg.text) ? (m: Message) => ({ ...m, ...pendingFields }) : (m: Message) => m)(decryptMessage({
  id: msg.id,
  conversationId: msg.conversation_id,
  senderId: msg.sender_id,
  senderName: msg.sender?.username,
  senderAvatar: msg.sender?.avatar,
  text: msg.text,
  timestamp: msg.created_at,
  status: msg.status || 'delivered',
  mediaUrl: msg.media_url || undefined,
  mediaType: msg.media_type || undefined,
  mediaSize: msg.media_size || undefined,
  mediaFilename: msg.media_filename || undefined,
  mediaThumbnail: msg.media_thumbnail || undefined,
  mediaWidth: msg.media_width || undefined,
  mediaHeight: msg.media_height || undefined,
  mediaDuration: msg.media_duration || undefined,
  messageType: msg.message_type,
  expenseId: msg.expense_id || null,
  isDeleted: !!msg.is_deleted,
  editedAt: msg.edited_at || null,
  replyTo: msg.reply_to
    ? {
        id: msg.reply_to.id,
        text: msg.reply_to.text,
        senderId: msg.reply_to.sender_id,
        senderName: msg.reply_to.sender_name,
        messageType: msg.reply_to.message_type,
        isDeleted: msg.reply_to.is_deleted,
      }
    : null,
  reactions: (msg.reactions || []).map((r: any) => ({ emoji: r.emoji, userIds: r.user_ids })),
} as Message));

/** v2 rows (and quoted v2 messages): fill from this device's local database. */
/**
 * Fill in encrypted (v2) messages from this browser's local store before they're shown, all at once:
 * showing "Waiting for this message…" placeholders first and filling them one by one made every
 * opened chat flicker (and re-render once per message).
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
        // Sent before this browser was linked (both times from the server's clock): it will never arrive here
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

/** Mark encrypted messages whose signature isn't from their sender's key (checked in the background). */
export function flagUnverified(dispatch: AppDispatch, conversationId: string, messages: Message[]) {
  unverifiedMessages(messages)
    .then(ids => ids.forEach(id => dispatch(updateMessage({ conversationId, messageId: id, updates: { e2eUnverified: true } }))))
    .catch(() => undefined); // offline: checked again next time the chat loads
}

/**
 * Fetch the newest page of messages for a conversation
 */
export const fetchMessages = (conversationId: string) => async (dispatch: AppDispatch, getState: () => RootState) => {
  // Fetch and check the members' device lists now, so the first message sends without waiting on them
  const c = getState().chat.conversations.find((x) => x.id === conversationId);
  if (c?.members?.length) warmChat({ conversationId, isGroup: !!c.isGroup, members: c.members });
  try {
    dispatch(setMessagesLoading(true));

    const response = await chatService.getMessages(conversationId);

    if (response.success && response.data) {
      const messages = await resolveV2(response.data.map(toMessage));
      dispatch(setMessages({ conversationId, messages, hasMore: !!response.has_more }));
      flagUnverified(dispatch, conversationId, messages);
    }
  } catch (error: any) {
    console.error('Failed to fetch messages:', error);
    dispatch(setError(error.message || 'Failed to load messages'));
  } finally {
    dispatch(setMessagesLoading(false));
  }
};

/**
 * Fetch the page of messages older than the oldest one loaded
 */
export const fetchOlderMessages = (conversationId: string) => async (
  dispatch: AppDispatch,
  getState: () => RootState
) => {
  const oldest = (getState().chat.messages[conversationId] || []).find(m => !m.id.startsWith('temp-'));
  if (!oldest) return;

  try {
    const response = await chatService.getMessages(conversationId, 50, oldest.id);
    if (response.success && response.data) {
      const messages = await resolveV2(response.data.map(toMessage));
      dispatch(prependMessages({ conversationId, messages, hasMore: !!response.has_more }));
      flagUnverified(dispatch, conversationId, messages);
    }
  } catch (error: any) {
    console.error('Failed to fetch older messages:', error);
    dispatch(setError(error.message || 'Failed to load older messages'));
  }
};

/**
 * Create a new direct conversation
 */
export const createDirectConversation = (userId: string) => async (dispatch: AppDispatch) => {
  try {
    const response = await chatService.createDirectConversation(userId);

    if (response.success && response.data) {
      const conv = response.data;
      const conversation = {
        id: conv.id,
        name: conv.other_user?.username || 'Unknown',
        avatar: conv.other_user?.avatar,
        lastMessage: '',
        lastMessageTime: conv.created_at,
        unreadCount: 0,
        isOnline: conv.other_user?.is_online || false,
        isTyping: false,
        isPinned: false,
        isGroup: false,
        members: [userId],
      };

      dispatch(addConversation(conversation));
      return { success: true, conversationId: conv.id };
    }

    return { success: false };
  } catch (error: any) {
    console.error('Failed to create conversation:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Create a new group conversation
 */
export const createGroupConversation = (
  name: string,
  memberIds: string[],
  extra: { description?: string; avatar_url?: string } = {}
) => async (dispatch: AppDispatch) => {
  try {
    const response = await chatService.createGroupConversation(name, memberIds, extra);

    if (response.success && response.data) {
      const conv = response.data;
      const conversation = {
        id: conv.id,
        name: conv.title || name,
        avatar: conv.avatar_url,
        lastMessage: '',
        lastMessageTime: conv.created_at,
        unreadCount: 0,
        isOnline: false,
        isTyping: false,
        isPinned: false,
        isGroup: true,
        members: memberIds,
      };

      dispatch(addConversation(conversation));
      return { success: true, conversationId: conv.id };
    }

    return { success: false };
  } catch (error: any) {
    console.error('Failed to create group:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Fetch available users for creating conversations
 */
export const fetchUsers = async (search?: string) => {
  try {
    const response = await chatService.getUsers(search);

    if (response.success && response.data) {
      return response.data.map((user: any) => ({
        id: user.id,
        username: user.username,
        name: user.name || user.username,
        email: user.email,
        avatar: user.avatar,
      }));
    }

    return [];
  } catch (error) {
    console.error('Failed to fetch users:', error);
    return [];
  }
};
/**
 * Pin or unpin a conversation for the current user (optimistic; max 3 pinned)
 */
export const togglePinConversation = (conversationId: string) => async (
  dispatch: AppDispatch,
  getState: () => RootState
) => {
  const conversation = getState().chat.conversations.find(c => c.id === conversationId);
  if (!conversation) return;

  const previous = conversation.pinnedAt ?? null;
  const pin = !conversation.isPinned;
  dispatch(setPinned({ conversationId, pinnedAt: pin ? new Date().toISOString() : null }));

  try {
    const response = await chatService.pinConversation(conversationId, pin);
    dispatch(setPinned({ conversationId, pinnedAt: response.data?.pinnedAt ?? null }));
  } catch (error) {
    dispatch(setPinned({ conversationId, pinnedAt: previous }));
    toast.error(parseApiError(error));
  }
};

/** Mute a chat for yourself (optimistic). */
export const muteConversation = (conversationId: string, duration: '8h' | '1w' | 'always' | null) => async (
  dispatch: AppDispatch,
  getState: () => RootState
) => {
  const previous = getState().chat.conversations.find(c => c.id === conversationId)?.mutedUntil ?? null;
  const hours = { '8h': 8, '1w': 24 * 7, always: 24 * 365 * 100 };
  dispatch(setConversationPrefs({ conversationId, mutedUntil: duration ? new Date(Date.now() + hours[duration] * 3600e3).toISOString() : null }));
  try {
    const response = await chatService.muteConversation(conversationId, duration);
    dispatch(setConversationPrefs({ conversationId, mutedUntil: response.data?.mutedUntil ?? null }));
  } catch (error) {
    dispatch(setConversationPrefs({ conversationId, mutedUntil: previous }));
    toast.error(parseApiError(error));
  }
};

/** Archive a chat for yourself, or bring it back (optimistic). */
export const archiveConversation = (conversationId: string, archived: boolean) => async (dispatch: AppDispatch) => {
  dispatch(setConversationPrefs({ conversationId, isArchived: archived, ...(archived ? { isPinned: false } : {}) }));
  try {
    await chatService.archiveConversation(conversationId, archived);
  } catch (error) {
    dispatch(setConversationPrefs({ conversationId, isArchived: !archived }));
    toast.error(parseApiError(error));
  }
};
