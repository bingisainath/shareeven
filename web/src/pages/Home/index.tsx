// src/pages/Home/index.tsx - COMPLETE WITH ALL INTEGRATIONS

import GroupAddIcon from '../../components/atoms/GroupAddIcon';
import { MessageSquareText, Settings as SettingsIcon, Users, Wallet } from 'lucide-react';
import { Avatar } from '../../components/atoms';
import { isMuted } from '../../components/molecules/ChatListItem';
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useAuth } from '../../app/AuthProvider';
import {
  Sidebar,
  ChatList,
  ChatWindow,
  ProfileModal,
  SearchUserModal,
  CreateGroupModal,
  EmptyState,
} from '../../components/organisms';
import {
  fetchConversations,
  fetchMessages,
  createDirectConversation,
  createGroupConversation,
  togglePinConversation,
  archiveConversation,
} from '../../redux/actions/chatActions';
import type { AppDispatch, RootState } from '../../redux/store';
import { selectOnlineUsers } from '../../redux/slices/websocketSlice';
import { clearUnreadCount } from '../../redux/slices/chatSlice';
import { chatService } from '../../services/chat.service';
import { NAVIGATE_EVENT } from '../../utils/events';
import { clearNotifications, setUnreadBadge } from '../../utils/notifications';
import { mediaService } from '../../services/media.service';
import { parseApiError } from '../../utils/apiError';
import { toast } from 'react-toastify';
import ExpensesPage from '../../components/expenses/ExpensesPage';
import ConnectionBanner from '../../components/molecules/ConnectionBanner';
import LinkApprovalPrompt from '../../components/organisms/LinkApprovalPrompt';
import SettingsPage from '../Settings';
import LogoutWarning, { logoutRisk } from '../../components/organisms/LogoutWarning';
import type { LogoutRisk } from '../../components/organisms/LogoutWarning';

// Stable empty value for selectors: returning a new [] each time makes components re-render
const EMPTY: never[] = [];

// import { selectActiveConversation } from '../../redux/slices/chatSlice';

const Home: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();

  // Auth
  const { user: currentUser, isAuthenticated, logout: authLogout } = useAuth();

  // Redux state
  const conversations = useSelector((state: RootState) => state.chat?.conversations ?? EMPTY);
  const isLoading = useSelector((state: RootState) => state.chat?.isLoading || false);

  const onlineUsers = useSelector(selectOnlineUsers);

  // Room join/leave is handled by ChatWindow
  const activeConversationId = params.conversationId;

  // Get other user ID from conversation
  const getOtherUserId = (conversation: any) => {
    if (conversation.isGroup) return null;
    return conversation.members?.find((id: string) => id !== currentUserId);
  };

  // Modal states
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSearchUserModal, setShowSearchUserModal] = useState(false);     // ✅ NEW
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);  // ✅ NEW

  // Active route
  // Unread count in the browser tab title, e.g. "(3) ShareEven"
  // Muted and archived chats don't count (like WhatsApp)
  const counted = conversations.filter(c => !c.isArchived && !isMuted(c.mutedUntil));
  const totalUnread = counted.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ShareEven` : 'ShareEven';
    setUnreadBadge(totalUnread);
  }, [totalUnread]);
  useEffect(() => () => { document.title = 'ShareEven'; setUnreadBadge(0); }, []);
  // A chat that's been read (here or on another device) shouldn't keep its notifications up
  useEffect(() => {
    conversations.forEach(c => { if (!c.unreadCount) clearNotifications(c.id); });
  }, [conversations]);

  // Lets toasts and other non-component code open a route (e.g. "added to group" toast)
  useEffect(() => {
    const onNavigate = (e: Event) => navigate((e as CustomEvent<string>).detail);
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
  }, [navigate]);

  const activeRoute = ['chat', 'groups', 'expenses', 'settings'].includes(location.pathname.split('/')[1])
    ? location.pathname.split('/')[1]
    : 'chat';

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  // Load conversations
  useEffect(() => {
    if (isAuthenticated && currentUser) {
      dispatch(fetchConversations());
    }
  }, [dispatch, isAuthenticated, currentUser]);

  // Load messages
  useEffect(() => {
    if (activeConversationId && isAuthenticated) {
      dispatch(fetchMessages(activeConversationId));
    }
  }, [activeConversationId, dispatch, isAuthenticated]);

  // Get active conversations
  const activeConversation = conversations.find(c => c.id === activeConversationId);

  // const activeConversation = useSelector(selectActiveConversation);
  const currentUserId = localStorage.getItem('userId') || '';

  const sortedConversations = useMemo(() => {
    const time = (value?: string | null) => (value ? new Date(value).getTime() : 0);
    // Pinned chats first (most recently pinned on top), then by latest message
    return [...conversations].sort((a, b) =>
      Number(!!b.isPinned) - Number(!!a.isPinned) ||
      time(b.pinnedAt) - time(a.pinnedAt) ||
      time(b.lastMessageTime) - time(a.lastMessageTime)
    );
  }, [conversations]);

  const otherUserId = activeConversation ? getOtherUserId(activeConversation) : null;
  const isOnline = otherUserId ? onlineUsers.includes(otherUserId) : false;

  // ✅ NEW: Handler for SearchUserModal
  const handleSelectUser = async (user: any) => {
    setCreatingConversation(true);

    try {

      if (!user || !user.id) {
        console.error('Invalid user:', user);
        toast.error('Invalid user selected');
        return;
      }


      // Check if DM already exists
      const existingDM = conversations.find(c =>
        !c.isGroup && c.members?.includes(user.id)
      );

      if (existingDM) {
        navigate(`/chat/${existingDM.id}`);
        return;
      }

      // Create new DM
      const result = await dispatch(createDirectConversation(user.id));

      if (result.success && result.conversationId) {
        // Refresh conversations
        await dispatch(fetchConversations());
        navigate(`/chat/${result.conversationId}`);
      } else {
        toast.error('Failed to create conversation');
      }
    } catch (error) {
      console.error('Error creating DM:', error);
      toast.error('Failed to create conversation');
    } finally {
      setCreatingConversation(false);
    }
  };

  // ✅ UPDATED: Handler for CreateGroupModal
  const handleCreateGroup = async (data: {
    name: string;
    description: string;
    memberIds: string[];
    avatar?: File;
  }) => {
    setCreatingConversation(true);

    try {
      let avatarUrl: string | undefined;
      if (data.avatar) {
        try {
          avatarUrl = (await mediaService.upload(data.avatar)).url;
        } catch (error) {
          toast.error(`Group photo not uploaded: ${parseApiError(error)}`);
        }
      }

      // Create group
      const result = await dispatch(createGroupConversation(data.name, data.memberIds, {
        description: data.description?.trim() || undefined,
        avatar_url: avatarUrl,
      }));

      if (result.success && result.conversationId) {
        setShowCreateGroupModal(false);
        // Refresh conversations
        await dispatch(fetchConversations());
        navigate(`/chat/${result.conversationId}`);
      } else {
        toast.error(`Failed to create group: ${result.error || 'Unknown error'}`);
      }
    } catch (error: any) {
      console.error('Error creating group:', error);
      toast.error(`Failed to create group: ${parseApiError(error)}`);
    } finally {
      setCreatingConversation(false);
    }
  };

  const handleNavigate = (path: string) => {
    navigate(path);
  };

  const handleSelectConversation = async (id: string) => {

    // Get conversation
    const conversation = conversations.find(c => c.id === id);

    // ✅ Mark as read on server
    if (conversation && (conversation.unreadCount ?? 0) > 0) {

      // Clear in Redux immediately for instant UI update
      dispatch(clearUnreadCount(id));

      // ✅ WAIT for server to mark as read, THEN fetch
      try {
        const result = await chatService.markConversationRead(id);

        if (result.success) {
          // Now the server has updated counts, safe to fetch
          await dispatch(fetchConversations());
        } else {
          console.error('❌ Failed to mark as read on server:', result.error);
        }
      } catch (error) {
        console.error('❌ Error marking as read:', error);
      }
    }

    // Navigate
    navigate(`/chat/${id}`);
  };

  // Logging out of the last signed-in device makes encrypted chats unreadable: warn first
  const [logoutWarning, setLogoutWarning] = useState<LogoutRisk | null>(null);
  const logoutNow = async () => {
    setLogoutWarning(null);
    await authLogout();
    navigate('/login');
  };
  const handleLogout = async () => {
    const risk = await logoutRisk();
    if (risk.lastDevice) setLogoutWarning(risk);
    else logoutNow();
  };

  // Loading state
  if (!currentUser && isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-muted-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-muted-600">Loading user data...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return null;
  }

  return (
    <div className="flex flex-col h-screen bg-muted-50 overflow-hidden">
      {currentUser && <LinkApprovalPrompt userId={currentUser.id} />}
      <ConnectionBanner />
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Sidebar */}
      <div className="w-20 flex-shrink-0 hidden md:block">
        <Sidebar
          user={{
            id: currentUser.id,
            name: currentUser.name || currentUser.username || currentUser.email.split('@')[0],
            username: currentUser.username || currentUser.email,
            avatar: currentUser.avatar
          }}
          activeRoute={`/${activeRoute}`}
          unreadChats={counted.filter(c => c.unreadCount && c.unreadCount > 0).length}
          pendingExpenses={0}
          onNavigate={handleNavigate}
          onProfileClick={() => setShowProfileModal(true)}
          onLogout={handleLogout}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex min-w-0 overflow-hidden">
        {/* CHAT PAGE */}
        {activeRoute === 'chat' && (
          <>
            {/* Chat List */}
            {/* <div className="w-full md:w-96 flex-shrink-0 border-r border-muted-200 bg-white/80"> */}
            <div className={`w-full md:w-80 lg:w-96 flex-shrink-0 border-r border-muted-200 bg-white/80 pb-16 md:pb-0 ${activeConversationId ? 'hidden md:block' : 'block'
              }`}>
              <ChatList
                conversations={sortedConversations}
                activeConversationId={activeConversationId}
                onSelectConversation={handleSelectConversation}
                onTogglePin={(id) => dispatch(togglePinConversation(id))}
                onToggleArchive={(id, archived) => dispatch(archiveConversation(id, archived))}
                onOpenMessage={(id, messageId) => navigate(`/chat/${id}?msg=${messageId}`)}
                currentUserId={currentUser?.id}
                onNewChat={() => setShowSearchUserModal(true)}
                onNewGroup={() => setShowCreateGroupModal(true)}
                isLoading={isLoading}
              />
            </div>

            {/* Chat Window - Show on mobile when active, always show on desktop */}
            <div className={`flex-1 min-w-0 ${activeConversationId ? 'block' : 'hidden md:block'  // ✅ FIX: Show window when chat is active
              }`}>
              {activeConversation ? (
                <ChatWindow
                  conversationId={activeConversation.id}
                  conversationName={activeConversation.name}
                  conversationAvatar={activeConversation.avatar}
                  isGroup={activeConversation.isGroup}
                  memberCount={activeConversation.members?.length}
                  isOnline={isOnline}
                  currentUserId={currentUser.id}
                  onBack={() => navigate('/chat')}  // ✅ FIX: Go back to list on mobile
                />
              ) : (
                <EmptyState
                  onNewChat={() => setShowSearchUserModal(true)}
                  onNewGroup={() => setShowCreateGroupModal(true)}
                />
              )}
            </div>
          </>
        )}

        {/* GROUPS PAGE */}
        {activeRoute === 'groups' && (
          <div className="flex-1 min-w-0 pb-16 md:pb-0">
            <GroupsPage
              groups={conversations.filter(c => c.isGroup)}
              onCreateGroup={() => setShowCreateGroupModal(true)}
              onOpenGroup={(id) => navigate(`/chat/${id}`)}
            />
          </div>
        )}

        {/* EXPENSES PAGE */}
        {activeRoute === 'expenses' && (
          <div className="flex-1 min-w-0 pb-16 md:pb-0">
            <ExpensesPage conversations={sortedConversations} currentUserId={currentUser.id} />
          </div>
        )}

        {/* SETTINGS PAGE */}
        {activeRoute === 'settings' && (
          <div className="flex-1 min-w-0 pb-16 md:pb-0">
            <SettingsPage
              user={currentUser}
              onEditProfile={() => setShowProfileModal(true)}
              onLogout={handleLogout}
            />
          </div>
        )}
      </div>

      {/* Mobile bottom nav (hidden inside an open chat, like other messengers) */}
      {!(activeRoute === 'chat' && activeConversationId) && (
        <MobileBottomNav activeRoute={activeRoute} onNavigate={handleNavigate} />
      )}

      {/* ✅ NEW: SearchUserModal */}
      <SearchUserModal
        isOpen={showSearchUserModal}
        onClose={() => setShowSearchUserModal(false)}
        onSelectUser={handleSelectUser}
        currentUserId={currentUser.id}
      />

      {/* ✅ UPDATED: CreateGroupModal with debouncing */}
      <CreateGroupModal
        isOpen={showCreateGroupModal}
        onClose={() => setShowCreateGroupModal(false)}
        onCreateGroup={handleCreateGroup}
        currentUserId={currentUser.id}
        isLoading={creatingConversation}
      />

      {/* Profile */}
      <ProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        onChanged={() => dispatch(fetchConversations())} // our name/photo shows in chats
      />

      {/* ✅ NEW: Loading overlay */}
      {creatingConversation && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 flex items-center gap-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
            <p className="text-muted-900 font-medium">Creating conversation...</p>
          </div>
        </div>
      )}
      </div>
      {logoutWarning && (
        <LogoutWarning
          risk={logoutWarning}
          onCancel={() => setLogoutWarning(null)}
          onConfirm={logoutNow}
          onOpenSettings={() => { setLogoutWarning(null); navigate('/settings/backup'); }}
        />
      )}
    </div>
  );
};

// ... Keep all other components (GroupsPage, SettingsPage, MobileBottomNav, EmptyState) same



// Groups Page Component
const GroupsPage: React.FC<{
  groups: any[];
  onCreateGroup: () => void;
  onOpenGroup: (id: string) => void;
}> = ({ groups, onCreateGroup, onOpenGroup }) => (
  <div className="px-4 py-6 sm:p-8 h-full overflow-auto">
    <div className="max-w-4xl mx-auto">
      <div className="flex items-end justify-between gap-4 mb-6">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-primary-500">Your circles</p>
          <h1 className="mt-0.5 font-display text-[28px] font-semibold text-muted-900">Groups</h1>
        </div>
        <button
          onClick={onCreateGroup}
          className="flex-shrink-0 whitespace-nowrap inline-flex items-center gap-2 h-10 px-4 bg-primary-700 hover:bg-primary-800 text-white text-sm font-bold rounded-[11px] shadow-[0_5px_14px_rgba(84,63,125,0.18)] transition-colors"
        >
          <GroupAddIcon size={19} />
          Create group
        </button>
      </div>

      {groups.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map(group => (
            <button
              type="button"
              key={group.id}
              className="card p-4 flex items-center gap-3.5 text-left hover:border-primary-200 hover:bg-primary-50/40 transition-colors"
              onClick={() => onOpenGroup(group.id)}
            >
              <Avatar src={group.avatar} alt={group.name} size="xl" group />
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-bold text-muted-900 truncate">{group.name}</span>
                  {group.unreadCount > 0 && (
                    <span className="min-w-[22px] h-[22px] px-1.5 grid place-items-center bg-primary-700 text-white text-xs font-bold rounded-full">
                      {group.unreadCount}
                    </span>
                  )}
                </span>
                <span className="block mt-0.5 text-sm text-muted-500 truncate">{group.lastMessage || 'No messages yet'}</span>
                <span className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-400">
                  <Users size={13} />
                  {group.members?.length || 0} members
                  {group.lastMessageTime && <> · {new Date(group.lastMessageTime).toLocaleDateString()}</>}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="card text-center px-6 py-16">
          <div className="w-20 h-20 mx-auto mb-5 rounded-[24px] bg-primary-50 text-primary-600 grid place-items-center">
            <Users size={36} strokeWidth={1.5} />
          </div>
          <h2 className="font-display text-xl font-semibold text-muted-900 mb-2">No groups yet</h2>
          <p className="text-muted-500">Create a group for your flat, a trip or a night out, and split costs inside it.</p>
        </div>
      )}
    </div>
  </div>
);



// Mobile Bottom Navigation
const MOBILE_TABS = [
  { route: 'chat', path: '/chat', label: 'Chats', icon: MessageSquareText },
  { route: 'groups', path: '/groups', label: 'Groups', icon: Users },
  { route: 'expenses', path: '/expenses', label: 'Expenses', icon: Wallet },
  { route: 'settings', path: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

const MobileBottomNav: React.FC<{ activeRoute: string; onNavigate: (path: string) => void }> = ({
  activeRoute,
  onNavigate
}) => (
  <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 grid grid-cols-4 auto-rows-[64px] px-2 pb-[env(safe-area-inset-bottom)] bg-white border-t border-muted-200" aria-label="Main">
    {MOBILE_TABS.map((tab) => {
      const active = activeRoute === tab.route;
      const TabIcon = tab.icon;
      return (
        <button
          key={tab.route}
          type="button"
          onClick={() => onNavigate(tab.path)}
          aria-current={active ? 'page' : undefined}
          className={`relative flex flex-col items-center justify-center gap-1 ${active ? 'text-primary-700' : 'text-muted-500'}`}
        >
          {active && <span className="absolute top-0 w-8 h-[3px] rounded-b bg-primary-700" aria-hidden />}
          <TabIcon size={22} strokeWidth={1.8} />
          <span className={`text-[11px] ${active ? 'font-bold' : 'font-medium'}`}>{tab.label}</span>
        </button>
      );
    })}
  </nav>
);

export default Home;
