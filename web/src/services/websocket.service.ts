// src/services/websocket.service.ts

import { WS_URL } from '../config/env';
import { isTokenExpired, tokenStore } from '../utils/token';
import { refreshAccessToken } from '../utils/authRefresh';

const MAX_RECONNECT_DELAY = 30_000;

// import { io, Socket } from 'socket.io-client';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  mediaUrl?: string;
  mediaType?: MediaType;
}

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface OutgoingMedia {
  mediaUrl: string;
  mediaType: MediaType;
  mediaSize?: number;
  mediaFilename?: string;
  mediaThumbnail?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number; // seconds, voice notes and videos
}

export interface WebSocketEvent {
  type: 'message' | 'typing' | 'read' | 'joined' | 'left' | 'online' | 'offline' | 'presence'
    | 'conversation_created' | 'conversation_updated' | 'conversation_removed' | 'conversation_pinned'
    | 'message_updated' | 'reactions_updated' | 'expense_changed' | 'receipt_scan_ready' | 'receipt_scan_progress' | 'error';
  roomId?: string;
  userId?: string;
  userIds?: string[];
  messageId?: string;
  clientId?: string;
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  text?: string;
  mediaUrl?: string | null;
  mediaType?: MediaType | null;
  mediaSize?: number | null;
  mediaFilename?: string | null;
  mediaThumbnail?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  mediaDuration?: number | null;
  timestamp?: string;
  status?: string;
  isTyping?: boolean;
  lastMessageId?: string;
  // encryption v2
  deviceId?: number;
  envelope?: import('../crypto/v2').IncomingEnvelope;
  // Envelope-first (proto=3): a new message's details next to its packet, and `message_sent` for ours
  meta?: import('../crypto/v2').EnvelopeMeta;
  fromDevice?: number;
  // error code devices_changed: whose devices to fetch again; e2e_retry_request: who asked
  code?: string;
  missing?: { user: string; device: number }[];
  extra?: { user: string; device: number }[];
  request?: import('../crypto/v2-platform/chat').RetryRequest;
  version?: number;
  readUpTo?: string | null;
  deliveredUpTo?: string | null;
  blocked?: boolean;
  expenseId?: string | null;
  receiptId?: string;
  error?: string | null;
  action?: string;
  message?: string;
  conversationId?: string;
  kind?: 'dm' | 'group';
  title?: string | null;
  createdBy?: string;
  createdByName?: string;
  removedBy?: string;
  removedByName?: string;
  left?: boolean;
  pinned?: boolean;
  pinnedAt?: string | null;
  // conversation_prefs (mute / archive on another of our devices)
  mutedUntil?: string | null;
  isArchived?: boolean;
  isPinned?: boolean;
  userName?: string | null;
  messageType?: 'text' | 'image' | 'video' | 'file' | 'system';
  replyTo?: {
    id: string; text: string; senderId: string;
    senderName?: string | null; messageType?: string; isDeleted?: boolean;
  } | null;
  reactions?: { emoji: string; userIds: string[] }[];
  isDeleted?: boolean;
  editedAt?: string;
}

type EventCallback = (event: WebSocketEvent) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  // private reconnectAttempts = 0;
  // private maxReconnectAttempts = 5;
  // private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private eventListeners: Map<string, EventCallback[]> = new Map();
  // Rooms this client wants to be in; re-joined whenever the socket (re)opens
  private rooms = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRejected = false; // server closed with 1008 (bad/expired token)
  private isConnecting = false;
  private shouldReconnect = true;
  private token: string | null = null;
  private wsUrl: string;
  // private listeners: Record<string, Array<(data: any) => void>> = {};
  private reconnectAttempts = 0;
  private reconnectDelay = 2000;

  constructor() {
    // WebSocket URL - adjust for your backend
    this.wsUrl = WS_URL;
    window.addEventListener('online', this.handleOnline);
  }

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING)
      ) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        return;
      }

      this.isConnecting = true;
      this.token = token;
      this.shouldReconnect = true;

      // proto=3: encrypted (v2) messages arrive as envelopes carrying their details (envelope-first)
      const url = `${this.wsUrl}?token=${encodeURIComponent(token)}&proto=3`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.rooms.forEach(roomId => this.send({ type: 'join', roomId }));
        this.emit('connected', {});  // ✅ ADD THIS
        resolve();
      };

      // ✅ ADD THIS - CRITICAL MISSING HANDLER
      this.ws.onmessage = (event) => {
        try {
          const data: WebSocketEvent = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (error) {
          console.error('❌ Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onerror = (err) => {
        console.error('❌ WebSocket error:', err);
        this.isConnecting = false;
        this.emit('error', { type: 'error', message: 'Connection error' });
        reject(err);
      };

      this.ws.onclose = (event) => {
        this.isConnecting = false;
        if (event.code === 1008) this.tokenRejected = true;
        this.stopHeartbeat();
        this.emit('disconnected', {});

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  // ✅ Add method to clear all listeners
  // clearListeners() {
  //   this.listeners = {};
  // }

  /**
   * Disconnect from WebSocket server
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rooms.clear();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(data: any) {
    if (!this.isConnected()) {
      console.warn('⚠️ WebSocket not connected, queuing message');
      // ✅ Don't throw - just return or queue for later
      return false;
    }

    // ✅ Log all outgoing WebSocket messages

    try {
      this.ws!.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error('❌ Failed to send WebSocket message:', error);
      return false;
    }
  }

  /** Send any event (used by encryption v2's message_v2). False if not connected. */
  sendEvent(data: Record<string, unknown>): boolean {
    return this.send(data);
  }

  /**
   * Join a conversation room
   */
  joinConversation(conversationId: string) {
    this.rooms.add(conversationId);
    // If not connected yet, the room is joined when the socket opens
    if (this.isConnected()) {
      this.send({ type: 'join', roomId: conversationId });
    }
  }

  /**
   * Leave a conversation room
   */
  leaveConversation(conversationId: string) {
    this.rooms.delete(conversationId);
    if (this.isConnected()) {
      this.send({ type: 'leave', roomId: conversationId });
    }
  }

  /**
   * Send a message
   */
  sendMessage(
    conversationId: string,
    clientId: string,
    text: string,
    media?: OutgoingMedia,
    replyToId?: string,
    hasLink?: boolean // encrypted messages: lets the server list it in the Links tab
  ) {
    const sent = this.send({
      type: 'message',
      roomId: conversationId,
      clientId,
      text,
      ...media,
      ...(hasLink ? { hasLink: true } : {}),
      ...(replyToId ? { replyToId } : {})
    });

    if (!sent) {
      console.error(`❌ Failed to send message - not connected`);
    }

    return sent;
  }

  /**
   * Send typing indicator
   */
  sendTyping(conversationId: string, isTyping: boolean) {
    this.send({
      type: 'typing',
      roomId: conversationId,
      isTyping
    });
  }

  /**
   * Mark message as read
   */
  /** A message from someone else reached this device (they see two ticks) */
  markDelivered(conversationId: string, lastMessageId: string) {
    this.send({
      type: 'delivered',
      roomId: conversationId,
      lastMessageId
    });
  }

  markAsRead(conversationId: string, lastMessageId: string) {
    this.send({
      type: 'read',
      roomId: conversationId,
      lastMessageId
    });
  }

  /**
   * Add event listener
   */
  on(event: string, callback: EventCallback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  /**
   * Remove event listener
   */
  off(event: string, callback: EventCallback) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit event to listeners
   */
  private emit(event: string, data: any) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(data: WebSocketEvent) {

    // Emit specific event type
    this.emit(data.type, data);

    // Emit generic 'message' event for all messages
    if (data.type === 'message') {
      this.emit('new-message', data);
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected()) {
        // Send ping (you can customize this based on your backend)
        try {
          this.ws!.send(JSON.stringify({ type: 'ping' }));
        } catch (error) {
          console.error('Heartbeat failed:', error);
        }
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  /** "Try now" from the offline banner: skip the wait before the next attempt. */
  retryNow() {
    if (!this.shouldReconnect || this.isConnected()) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.scheduleReconnect(true);
  }

  private scheduleReconnect(immediate = false) {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = immediate
      ? 0
      : Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY);


    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;

      // Use the newest token; renew it if it expired (or was rejected) while we were away
      let token = tokenStore.get();
      if (!token || isTokenExpired(token) || this.tokenRejected) {
        token = await refreshAccessToken();
      }
      if (!this.shouldReconnect) return;
      if (!token) {
        // Refresh failed. If we still have a refresh token it was a network problem: keep trying.
        // (If the session really ended, tokens are cleared and the app logs out.)
        if (tokenStore.getRefresh()) this.scheduleReconnect();
        return;
      }

      this.tokenRejected = false;
      this.connect(token).catch(error => {
        console.error('Reconnection failed:', error);
      });
    }, delay);
  }

  /** Browser came back online: reconnect now instead of waiting for the backoff */
  private handleOnline = () => {
    if (!this.shouldReconnect || this.isConnected() || !this.token) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.scheduleReconnect(true);
  };


}

// Export singleton instance
export const wsService = new WebSocketService();