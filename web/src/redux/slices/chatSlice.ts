// src/redux/slices/chatSlice.ts - UPDATED WITH WEBSOCKET

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface ReplyPreview {
  id: string;
  text: string;
  senderId: string;
  senderName?: string | null;
  messageType?: string;
  isDeleted?: boolean;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  clientId?: string; // temp id of the optimistic copy this message replaces
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'file';
  mediaSize?: number;
  mediaFilename?: string;
  mediaThumbnail?: string; // poster frame for videos
  mediaWidth?: number; // pixel size, used to reserve space before media loads
  mediaHeight?: number;
  uploadProgress?: number; // 0-100 while an attachment is uploading
  uploadFailed?: boolean; // upload failed: the bubble offers Retry / Remove
  mediaDuration?: number; // seconds (voice notes, videos)
  messageType?: 'text' | 'image' | 'video' | 'audio' | 'file' | 'system';
  replyTo?: ReplyPreview | null;
  reactions?: Reaction[];
  isDeleted?: boolean;
  editedAt?: string | null;
  expenseId?: string | null; // system message shown as an expense card
  // End-to-end encryption (src/crypto): 'encrypted' = decrypted fine, 'unreadable' = not for this device
  e2e?: 'encrypted' | 'unreadable' | 'pending'; // pending: v2 content not decrypted on this device (yet)
  e2eVersion?: 2;
  localId?: string; // v2: the sender's message id (key in the device's local database)
  mediaV2?: { sha256: string; size: number }; // v2 files (PMV2 format)
  thumbV2?: { sha256: string; size: number };
  mediaBlur?: string; // v2: tiny base64 JPEG shown blurred until the photo is decrypted
  e2eUnverified?: boolean; // signed with a key that isn't the sender's
  senderSignKey?: string;
  mediaKey?: string; // the encrypted file's key (base64)
  mediaMime?: string;
  thumbKey?: string; // key of the encrypted video poster
}

const byTimestamp = (a: Message, b: Message) =>
  new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();

interface Conversation {
  id: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
  lastMessageTime?: string;
  lastMessageSenderId?: string | null;
  unreadCount?: number;
  isOnline?: boolean;
  isTyping?: boolean;
  isPinned?: boolean;
  pinnedAt?: string | null;
  mutedUntil?: string | null; // muted for you until then (no notifications)
  isArchived?: boolean; // archived by you: in the Archived list, not the main one
  isGroup?: boolean;
  members?: string[];
  otherUserId?: string | null; // direct chats: the other person
  isBlocked?: boolean; // direct chats: you blocked the other person
}

interface ChatState {
  conversations: Conversation[];
  messages: Record<string, Message[]>; // conversationId -> messages[]
  hasMoreMessages: Record<string, boolean>; // conversationId -> older messages exist on server
  // How many were unread when each chat was last opened (its unreadCount is cleared on opening):
  // the chat window puts its "New messages" line there
  unreadWhenOpened: Record<string, number>;
  activeConversationId?: string;
  isLoading: boolean;
  messagesLoading: boolean;
  error?: string;
}

const initialState: ChatState = {
  conversations: [],
  messages: {},
  hasMoreMessages: {},
  unreadWhenOpened: {},
  activeConversationId: undefined,
  isLoading: false,
  messagesLoading: false,
  error: undefined
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    // Conversations
    setConversations: (state, action: PayloadAction<Conversation[]>) => {
      state.conversations = action.payload;
    },

    addConversation: (state, action: PayloadAction<Conversation>) => {
      state.conversations.unshift(action.payload);
    },

    updateConversation: (state, action: PayloadAction<{ id: string; updates: Partial<Conversation> }>) => {
      const index = state.conversations.findIndex(c => c.id === action.payload.id);
      if (index !== -1) {
        state.conversations[index] = { ...state.conversations[index], ...action.payload.updates };
      }
    },

    updateConversationLastMessage: (
      state,
      action: PayloadAction<{
        conversationId: string;
        lastMessage: string;
        timestamp: string;
        createIfNotExists?: boolean;
      }>
    ) => {
      const { conversationId, lastMessage, timestamp, createIfNotExists } = action.payload;
      let conversation = state.conversations.find(c => c.id === conversationId);

      if (!conversation && createIfNotExists) {
        // Create placeholder
        conversation = {
          id: conversationId,
          name: 'New Conversation',
          avatar: undefined,
          lastMessage: lastMessage,
          lastMessageTime: timestamp,
          unreadCount: 1,
          isOnline: false,
          isGroup: false,
          members: [],
        };
        state.conversations.unshift(conversation);
      } else if (conversation) {
        conversation.lastMessage = lastMessage;
        conversation.lastMessageTime = timestamp;

        // Move to top
        const index = state.conversations.indexOf(conversation);
        if (index > 0) {
          state.conversations.splice(index, 1);
          state.conversations.unshift(conversation);
        }
      }
    },

    removeConversation: (state, action: PayloadAction<string>) => {
      state.conversations = state.conversations.filter(c => c.id !== action.payload);
    },

    updateUserOnlineStatus: (
      state,
      action: PayloadAction<{ userId: string; isOnline: boolean }>
    ) => {
      const { userId, isOnline } = action.payload;
      const currentUserId = localStorage.getItem('userId');
      if (userId === currentUserId) return;

      state.conversations.forEach(conv => {
        if (!conv.isGroup && conv.members?.includes(userId)) {
          conv.isOnline = isOnline;
        }
      });
    },

    // Messages
    setMessages: (
      state,
      action: PayloadAction<{ conversationId: string; messages: Message[]; hasMore?: boolean }>
    ) => {
      const { conversationId, messages, hasMore } = action.payload;
      const fetchedIds = new Set(messages.map(m => m.id));
      const newestFetched = messages.length
        ? new Date(messages[messages.length - 1].timestamp).getTime()
        : 0;
      const oldestFetched = messages.length
        ? new Date(messages[0].timestamp).getTime()
        : Infinity;

      // Keep pending sends, live messages that arrived while the request was in flight,
      // and older pages already loaded with "Load older messages" (e.g. on a re-fetch after reconnect)
      const keep = (state.messages[conversationId] || []).filter(m => {
        if (fetchedIds.has(m.id)) return false;
        const time = new Date(m.timestamp).getTime();
        return m.id.startsWith('temp-') || time > newestFetched || time < oldestFetched;
      });

      state.messages[conversationId] = [...messages, ...keep].sort(byTimestamp);
      state.hasMoreMessages[conversationId] = !!hasMore;
    },

    prependMessages: (
      state,
      action: PayloadAction<{ conversationId: string; messages: Message[]; hasMore: boolean }>
    ) => {
      const { conversationId, messages, hasMore } = action.payload;
      const existing = state.messages[conversationId] || [];
      const existingIds = new Set(existing.map(m => m.id));
      state.messages[conversationId] = [
        ...messages.filter(m => !existingIds.has(m.id)),
        ...existing,
      ].sort(byTimestamp);
      state.hasMoreMessages[conversationId] = hasMore;
    },

    /**
     * Add a message from the server. If it is the echo of one of our optimistic
     * messages (same clientId), replace that copy instead of adding a new one.
     */
    upsertMessage: (state, action: PayloadAction<{ conversationId: string; message: Message }>) => {
      const { conversationId, message } = action.payload;
      const list = state.messages[conversationId] || (state.messages[conversationId] = []);

      const index = list.findIndex(m =>
        m.id === message.id || (!!message.clientId && m.id === message.clientId)
      );
      if (index !== -1) {
        list[index] = { ...list[index], ...message };
      } else {
        list.push(message);
      }
      list.sort(byTimestamp);
    },

    /** A message was edited or deleted (by its sender, possibly on another device) */
    applyMessageUpdate: (
      state,
      action: PayloadAction<{
        conversationId: string;
        messageId: string;
        text?: string;
        editedAt?: string | null;
        isDeleted?: boolean;
      }>
    ) => {
      const { conversationId, messageId, text, editedAt, isDeleted } = action.payload;
      (state.messages[conversationId] || []).forEach(m => {
        if (m.id === messageId) {
          if (isDeleted) {
            Object.assign(m, {
              isDeleted: true, text: '', mediaUrl: undefined, mediaType: undefined,
              mediaFilename: undefined, mediaSize: undefined, reactions: [], editedAt: null,
            });
          } else {
            if (text !== undefined) m.text = text;
            if (editedAt !== undefined) m.editedAt = editedAt;
          }
        }
        // Keep reply quotes of this message in sync
        if (m.replyTo?.id === messageId) {
          if (isDeleted) m.replyTo = { ...m.replyTo, isDeleted: true, text: 'This message was deleted' };
          else if (text !== undefined) m.replyTo = { ...m.replyTo, text };
        }
      });
    },

    setReactions: (
      state,
      action: PayloadAction<{ conversationId: string; messageId: string; reactions: Reaction[] }>
    ) => {
      const { conversationId, messageId, reactions } = action.payload;
      const message = (state.messages[conversationId] || []).find(m => m.id === messageId);
      if (message) message.reactions = reactions;
    },

    /** Mute / archive (and the unpin archiving does), from this browser or another of your devices. */
    setConversationPrefs: (state, action: PayloadAction<{ conversationId: string; mutedUntil?: string | null; isArchived?: boolean; isPinned?: boolean }>) => {
      const { conversationId, ...prefs } = action.payload;
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) return;
      if (prefs.mutedUntil !== undefined) conversation.mutedUntil = prefs.mutedUntil;
      if (prefs.isArchived !== undefined) conversation.isArchived = prefs.isArchived;
      if (prefs.isPinned === false) {
        conversation.isPinned = false;
        conversation.pinnedAt = null;
      }
    },

    setPinned: (state, action: PayloadAction<{ conversationId: string; pinnedAt: string | null }>) => {
      const conversation = state.conversations.find(c => c.id === action.payload.conversationId);
      if (conversation) {
        conversation.isPinned = !!action.payload.pinnedAt;
        conversation.pinnedAt = action.payload.pinnedAt;
      }
    },

    removeMessage: (state, action: PayloadAction<{ conversationId: string; messageId: string }>) => {
      const { conversationId, messageId } = action.payload;
      const list = state.messages[conversationId];
      if (list) {
        state.messages[conversationId] = list.filter(m => m.id !== messageId);
      }
    },

    /** You blocked or unblocked someone (here or on another of your devices). */
    setBlocked: (state, action: PayloadAction<{ userId: string; blocked: boolean }>) => {
      state.conversations.forEach(c => {
        if (c.otherUserId === action.payload.userId) c.isBlocked = action.payload.blocked;
      });
    },

    /** Every member has the conversation on a device up to deliveredUpTo: one tick becomes two. */
    markMessagesDelivered: (state, action: PayloadAction<{ conversationId: string; deliveredUpTo: string }>) => {
      const { conversationId, deliveredUpTo } = action.payload;
      const limit = new Date(deliveredUpTo).getTime();
      (state.messages[conversationId] || []).forEach(m => {
        if (m.status === 'sent' && new Date(m.timestamp).getTime() <= limit) {
          m.status = 'delivered';
        }
      });
    },

    /** Everyone in the conversation has read up to readUpTo: update sent/delivered ticks. */
    markMessagesRead: (state, action: PayloadAction<{ conversationId: string; readUpTo: string }>) => {
      const { conversationId, readUpTo } = action.payload;
      const limit = new Date(readUpTo).getTime();
      (state.messages[conversationId] || []).forEach(m => {
        if ((m.status === 'sent' || m.status === 'delivered') && new Date(m.timestamp).getTime() <= limit) {
          m.status = 'read';
        }
      });
    },

    /** Recompute DM online flags from a full list of online user ids. */
    syncOnlineStatus: (state, action: PayloadAction<{ onlineUserIds: string[]; currentUserId: string | null }>) => {
      const { onlineUserIds, currentUserId } = action.payload;
      const online = new Set(onlineUserIds);
      state.conversations.forEach(conv => {
        if (conv.isGroup || !conv.members) return;
        const otherId = conv.members.find(id => id !== currentUserId);
        conv.isOnline = !!otherId && online.has(otherId);
      });
    },

    replaceOptimisticMessage: (
      state,
      action: PayloadAction<{
        conversationId: string;
        tempId: string;
        message: Message
      }>
    ) => {
      const { conversationId, tempId, message } = action.payload;

      if (!state.messages[conversationId]) return;

      const index = state.messages[conversationId].findIndex(m => m.id === tempId);

      if (index !== -1) {
        // Replace optimistic with real
        state.messages[conversationId][index] = message;
      } else {
        // Not found, just add it
        state.messages[conversationId].push(message);
      }

      // Sort by timestamp
      state.messages[conversationId].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    },

    addMessage: (
      state,
      action: PayloadAction<{ conversationId: string; message: Message }>
    ) => {
      const { conversationId, message } = action.payload;

      if (!state.messages[conversationId]) {
        state.messages[conversationId] = [];
      }

      // ✅ Check if message already exists
      const exists = state.messages[conversationId].some(m => m.id === message.id);

      if (!exists) {
        state.messages[conversationId].push(message);

        // Sort by timestamp
        state.messages[conversationId].sort((a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
      } else {
      }
    },


    updateMessage: (state, action: PayloadAction<{ conversationId: string; messageId: string; updates: Partial<Message> }>) => {
      const { conversationId, messageId, updates } = action.payload;
      const messages = state.messages[conversationId];

      if (messages) {
        const index = messages.findIndex(m => m.id === messageId);
        if (index !== -1) {
          messages[index] = { ...messages[index], ...updates };
        }
      }
    },


    // Replace temp message ID with real ID from server
    replaceMessageId: (state, action: PayloadAction<{ conversationId: string; tempId: string; realId: string }>) => {
      const { conversationId, tempId, realId } = action.payload;
      const messages = state.messages[conversationId];

      if (messages) {
        const index = messages.findIndex(m => m.id === tempId);
        if (index !== -1) {
          messages[index].id = realId;
          messages[index].status = 'sent';
        }
      }
    },

    // Active conversation
    setActiveConversation: (state, action: PayloadAction<string | undefined>) => {
      state.activeConversationId = action.payload;

      // Mark as read
      if (action.payload) {
        const conv = state.conversations.find(c => c.id === action.payload);
        if (conv) {
          if (conv.unreadCount) state.unreadWhenOpened[conv.id] = conv.unreadCount;
          conv.unreadCount = 0;
        }
      }
    },

    // ✅ Create placeholder conversation for new messages
    createPlaceholderConversation: (
      state,
      action: PayloadAction<{
        conversationId: string;
        senderId: string;
        senderName?: string;
        senderAvatar?: string;
        lastMessage: string;
        timestamp: string;
      }>
    ) => {
      const { conversationId, senderId, senderName, senderAvatar, lastMessage, timestamp } = action.payload;

      // Check if already exists
      const exists = state.conversations.some(c => c.id === conversationId);
      if (exists) return;


      // Create placeholder
      const placeholder: Conversation = {
        id: conversationId,
        name: senderName || 'Unknown',
        avatar: senderAvatar || undefined,
        lastMessage: lastMessage,
        lastMessageTime: timestamp,
        unreadCount: 1,  // Start with 1 unread
        isOnline: false,
        isGroup: false,
        members: [senderId],  // Will be updated when full data loads
        isPinned: false,
        isTyping: false,
      };

      // Add to top of list
      state.conversations.unshift(placeholder);

    },


    incrementUnreadCount: (state, action: PayloadAction<string>) => {
      const conversation = state.conversations.find(c => c.id === action.payload);
      if (conversation) {
        conversation.unreadCount = (conversation.unreadCount || 0) + 1;
      }
    },

    /** The chat window has read it for its "New messages" line: don't use it again next time. */
    forgetUnreadWhenOpened: (state, action: PayloadAction<string>) => {
      delete state.unreadWhenOpened[action.payload];
    },

    clearUnreadCount: (state, action: PayloadAction<string>) => {
      const conversation = state.conversations.find(c => c.id === action.payload);
      if (conversation) {
        if (conversation.unreadCount) state.unreadWhenOpened[conversation.id] = conversation.unreadCount;
        conversation.unreadCount = 0;
      }
    },

    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },

    setMessagesLoading: (state, action: PayloadAction<boolean>) => {
      state.messagesLoading = action.payload;
    },

    setError: (state, action: PayloadAction<string | undefined>) => {
      state.error = action.payload;
    }
  }
});

export const {
  setConversations,
  addConversation,
  updateConversation,
  removeConversation,
  updateUserOnlineStatus,
  setMessages,
  prependMessages,
  upsertMessage,
  removeMessage,
  setPinned,
  setConversationPrefs,
  applyMessageUpdate,
  setReactions,
  markMessagesRead,
  markMessagesDelivered,
  setBlocked,
  syncOnlineStatus,
  replaceOptimisticMessage,
  addMessage,
  updateMessage,
  updateConversationLastMessage,
  replaceMessageId,
  setActiveConversation,
  createPlaceholderConversation,
  incrementUnreadCount,
  clearUnreadCount,
  forgetUnreadWhenOpened,
  setLoading,
  setMessagesLoading,
  setError
} = chatSlice.actions;

export default chatSlice.reducer;

// Selectors
export const selectActiveConversation = (state: { chat: ChatState }) =>
  state.chat.conversations.find(c => c.id === state.chat.activeConversationId);