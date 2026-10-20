// src/components/organisms/ConversationInfoPanel/index.tsx
// Slide-over with group info (name, photo, description, members, admin actions, leave)
// or contact info for a direct chat.

import { Archive, ArchiveRestore, Ban, Flag } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { Avatar, Loading } from '../../atoms';
import Icon from '../../atoms/Icon';
import { chatService } from '../../../services/chat.service';
import type { ConversationDetails, ConversationMemberInfo } from '../../../services/chat.service';
import { mediaService } from '../../../services/media.service';
import { userService } from '../../../services/user.service';
import { useDebounce } from '../../../hooks/useDebounce';
import { parseApiError } from '../../../utils/apiError';
import { mediaTypeOf, validateFile } from '../../../utils/media';
import { CONVERSATION_UPDATED_EVENT, NAVIGATE_EVENT } from '../../../utils/events';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../../redux/store';
import { archiveConversation, muteConversation, togglePinConversation } from '../../../redux/actions/chatActions';
import { isMuted } from '../../molecules/ChatListItem';
import { ChatExpenseSettings } from '../../expenses/ExpenseSettingsSections';
import SharedMedia, { SharedMediaRow } from '../SharedMedia';
import EncryptionInfo from '../EncryptionInfo';
import ReportDialog from '../ReportDialog';
import type { ReportTarget } from '../ReportDialog';
import { safetyService } from '../../../services/safety.service';
import { setBlocked } from '../../../redux/slices/chatSlice';
import { confirmDialog } from '../ConfirmDialog';

interface ConversationInfoPanelProps {
  conversationId: string;
  isOpen: boolean;
  onClose: () => void;
  startAddingMembers?: boolean; // opened from the header's "Add members" button
}

type SearchUser = { id: string; username: string; name?: string; avatar?: string };

const ConversationInfoPanel: React.FC<ConversationInfoPanelProps> = ({ conversationId, isOpen, onClose, startAddingMembers }) => {
  const [details, setDetails] = useState<ConversationDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');

  const [addingMembers, setAddingMembers] = useState(false);
  const [showShared, setShowShared] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const dispatch = useDispatch<AppDispatch>();
  // Two plain values (a selector returning a new object would re-render on every store change)
  const mutedUntil = useSelector((state: RootState) => state.chat.conversations.find(x => x.id === conversationId)?.mutedUntil ?? null);
  const isArchived = useSelector((state: RootState) => !!state.chat.conversations.find(x => x.id === conversationId)?.isArchived);
  const prefs = { mutedUntil, isArchived };
  const isBlocked = useSelector((state: RootState) => !!state.chat.conversations.find(x => x.id === conversationId)?.isBlocked);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const muted = isMuted(prefs.mutedUntil);
  const mutedLabel = !muted ? '' : new Date(prefs.mutedUntil!).getFullYear() > 2100 ? 'Muted always'
    : `Muted until ${new Date(prefs.mutedUntil!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  const isPinned = useSelector((state: RootState) =>
    !!state.chat.conversations.find(c => c.id === conversationId)?.isPinned
  );

  // Parents pass a new onClose every render; keep it out of load's dependencies
  // so the panel only refetches when it opens or the conversation changes.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async () => {
    try {
      setDetails(await chatService.getConversation(conversationId));
    } catch (error) {
      toast.error(`Couldn't load info: ${parseApiError(error)}`);
      onCloseRef.current();
    }
  }, [conversationId]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [isOpen, load]);

  // Refresh when the group changes (from us or another admin)
  useEffect(() => {
    if (!isOpen) return;
    const onUpdated = (e: Event) => {
      if ((e as CustomEvent<string>).detail === conversationId) load();
    };
    window.addEventListener(CONVERSATION_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(CONVERSATION_UPDATED_EVENT, onUpdated);
  }, [isOpen, conversationId, load]);

  useEffect(() => {
    if (!isOpen) {
      setEditingName(false);
      setEditingDescription(false);
      setAddingMembers(false);
      setShowShared(false);
      setSearch('');
    }
  }, [isOpen]);

  // Search people to add
  useEffect(() => {
    if (!addingMembers || !debouncedSearch.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    userService.searchUsers(debouncedSearch.trim())
      .then(response => {
        if (!cancelled) setSearchResults(response.data || []);
      })
      .catch(() => {
        if (!cancelled) setSearchResults([]);
      });
    return () => { cancelled = true; };
  }, [debouncedSearch, addingMembers]);

  // Escape closes the panel
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const membersRef = useRef<HTMLElement>(null);
  const handledAddMembers = useRef(false);

  // Opened via "Add members": go straight to the search (admins only), once per opening
  useEffect(() => {
    if (!isOpen) {
      handledAddMembers.current = false;
      return;
    }
    if (!startAddingMembers || handledAddMembers.current || !details || details.id !== conversationId) return;
    handledAddMembers.current = true;
    if (details.my_role === 'admin') {
      setAddingMembers(true);
      membersRef.current?.scrollIntoView({ block: 'start' });
    } else {
      toast.info('Only group admins can add members');
    }
  }, [isOpen, startAddingMembers, details, conversationId]);

  if (!isOpen) return null;

  const isGroup = details?.kind === 'group';
  const isAdmin = details?.my_role === 'admin';
  const me = details?.members.find(m => m.is_me);
  const other = details?.members.find(m => !m.is_me);
  const memberIds = new Set(details?.members.map(m => m.id));

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
      await load();
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => run(async () => {
    await chatService.updateGroup(conversationId, { title: nameDraft.trim() });
    setEditingName(false);
  });

  const saveDescription = () => run(async () => {
    await chatService.updateGroup(conversationId, { description: descriptionDraft.trim() });
    setEditingDescription(false);
  });

  const changePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const error = validateFile(file) || (mediaTypeOf(file) !== 'image' ? 'Please choose an image.' : null);
    if (error) {
      toast.error(error);
      return;
    }
    await run(async () => {
      const uploaded = await mediaService.upload(file);
      await chatService.updateGroup(conversationId, { avatar_url: uploaded.url });
    }, 'Group photo updated');
  };

  const addMember = (user: SearchUser) => run(
    () => chatService.addGroupMembers(conversationId, [user.id]),
    `${user.username} added`
  );

  const setRole = (member: ConversationMemberInfo, role: 'admin' | 'member') => run(
    () => chatService.updateGroupMemberRole(conversationId, member.id, role)
  );

  const removeMember = async (member: ConversationMemberInfo) => {
    if (!(await confirmDialog({ title: `Remove ${member.username} from the group?`, message: "They stop getting the group's messages. Shared expenses stay.", confirmText: 'Remove', danger: true }))) return;
    run(() => chatService.removeGroupMember(conversationId, member.id), `${member.username} removed`);
  };

  const leaveGroup = async () => {
    if (!me || !(await confirmDialog({ title: 'Leave this group?', message: 'You will stop receiving its messages.', confirmText: 'Leave', danger: true }))) return;
    setBusy(true);
    try {
      await chatService.removeGroupMember(conversationId, me.id);
      toast.success('You left the group');
      onClose();
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: '/chat' }));
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const title = isGroup ? details?.title : other?.name || other?.username;
  const avatar = isGroup ? details?.avatar_url : other?.avatar;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={onClose} />

      <aside
        role="dialog"
        aria-label={isGroup ? 'Group info' : 'Contact info'}
        className="relative w-full sm:w-96 h-full bg-white shadow-elevated flex flex-col animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-muted-200">
          <button onClick={onClose} className="p-2 hover:bg-muted-100 rounded-lg transition-colors" title="Close" aria-label="Close">
            <Icon name="close" size={20} className="text-muted-600" />
          </button>
          <h2 className="text-lg font-semibold text-muted-900">{isGroup ? 'Group info' : 'Contact info'}</h2>
          {busy && <Loading size="sm" className="ml-auto" />}
        </div>

        {loading || !details ? (
          <div className="flex-1 flex items-center justify-center"><Loading size="lg" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {/* Photo + name */}
            <div className="flex flex-col items-center px-6 pt-6 pb-4 border-b border-muted-100">
              <Avatar src={avatar} alt={title || 'Group'} size="2xl" group={isGroup} />
              {isGroup && isAdmin && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => photoInputRef.current?.click()}
                    disabled={busy}
                    className="px-3 py-1 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-lg"
                  >
                    {avatar ? 'Change photo' : 'Add photo'}
                  </button>
                  {avatar && (
                    <button
                      onClick={() => run(() => chatService.updateGroup(conversationId, { avatar_url: '' }))}
                      disabled={busy}
                      className="px-3 py-1 text-xs font-medium text-accent-600 bg-accent-50 hover:bg-accent-100 rounded-lg"
                    >
                      Remove
                    </button>
                  )}
                  <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={changePhoto} />
                </div>
              )}

              {isGroup && editingName ? (
                <div className="w-full mt-4 flex gap-2">
                  <input
                    value={nameDraft}
                    onChange={e => setNameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && nameDraft.trim()) saveName(); }}
                    maxLength={100}
                    autoFocus
                    aria-label="Group name"
                    className="flex-1 min-w-0 px-3 py-2 border-2 border-primary-300 rounded-lg outline-none focus:border-primary-600"
                  />
                  <button onClick={saveName} disabled={busy || !nameDraft.trim()} className="px-3 py-2 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50">Save</button>
                  <button onClick={() => setEditingName(false)} className="px-2 py-2 text-sm text-muted-600 hover:bg-muted-100 rounded-lg">Cancel</button>
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 max-w-full">
                  <h3 className="text-xl font-bold text-muted-900 truncate">{title}</h3>
                  {isGroup && isAdmin && (
                    <button
                      onClick={() => { setNameDraft(details.title || ''); setEditingName(true); }}
                      className="p-1 hover:bg-muted-100 rounded-lg"
                      title="Rename group"
                      aria-label="Rename group"
                    >
                      <Icon name="edit" size={16} className="text-muted-500" />
                    </button>
                  )}
                </div>
              )}
              <p className="text-sm text-muted-500 mt-1">
                {isGroup ? `Group · ${details.members.length} members` : `@${other?.username}`}
              </p>
            </div>

            {/* Description / about */}
            <section className="px-6 py-4 border-b border-muted-100">
              <div className="flex items-center justify-between mb-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-500">
                  {isGroup ? 'Description' : 'About'}
                </h4>
                {isGroup && isAdmin && !editingDescription && (
                  <button
                    onClick={() => { setDescriptionDraft(details.description || ''); setEditingDescription(true); }}
                    className="text-xs font-medium text-primary-700 hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
              {editingDescription ? (
                <div>
                  <textarea
                    value={descriptionDraft}
                    onChange={e => setDescriptionDraft(e.target.value)}
                    maxLength={500}
                    rows={3}
                    autoFocus
                    className="w-full px-3 py-2 border-2 border-primary-300 rounded-lg outline-none focus:border-primary-600 resize-none text-sm"
                  />
                  <div className="flex justify-end gap-2 mt-2">
                    <button onClick={() => setEditingDescription(false)} className="px-3 py-1.5 text-sm text-muted-600 hover:bg-muted-100 rounded-lg">Cancel</button>
                    <button onClick={saveDescription} disabled={busy} className="px-3 py-1.5 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50">Save</button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-700 whitespace-pre-wrap break-words">
                  {(isGroup ? details.description : other?.bio) || (
                    <span className="text-muted-400">{isGroup ? 'No description' : 'No bio yet'}</span>
                  )}
                </p>
              )}
            </section>

            {/* End-to-end encryption, and the security code for direct chats */}
            <EncryptionInfo
              conversationId={conversationId}
              other={!isGroup && other ? { id: other.id, name: other.name || other.username } : undefined}
            />

            {/* Photos, videos, files, voice notes and links shared here */}
            <SharedMediaRow conversationId={conversationId} onOpen={() => setShowShared(true)} />

            {/* Expenses: currency, simplify debts, receipt model */}
            <section className="px-6 py-4 border-b border-muted-100">
              <ChatExpenseSettings
                conversationId={conversationId}
                onOpenExpenses={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: `/expenses?chat=${conversationId}` }));
                }}
              />
            </section>

            {/* Members */}
            {isGroup && (
              <section ref={membersRef} className="px-6 py-4 border-b border-muted-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-500">
                    {details.members.length} members
                  </h4>
                  {isAdmin && (
                    <button
                      onClick={() => { setAddingMembers(open => !open); setSearch(''); }}
                      className="flex items-center gap-1 text-xs font-medium text-primary-700 hover:underline"
                    >
                      <Icon name="plus" size={14} /> {addingMembers ? 'Done' : 'Add members'}
                    </button>
                  )}
                </div>

                {addingMembers && (
                  <div className="mb-4">
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search people to add..."
                      autoFocus
                      className="w-full px-3 py-2 border-2 border-muted-200 rounded-lg outline-none focus:border-primary-600 text-sm"
                    />
                    <div className="mt-2 space-y-1">
                      {searchResults.filter(u => !memberIds.has(u.id)).map(user => (
                        <button
                          key={user.id}
                          onClick={() => addMember(user)}
                          disabled={busy}
                          className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-primary-50 text-left disabled:opacity-50"
                        >
                          <Avatar src={user.avatar} alt={user.username} size="sm" />
                          <span className="flex-1 min-w-0 text-sm font-medium text-muted-900 truncate">{user.username}</span>
                          <Icon name="plus" size={16} className="text-primary-600" />
                        </button>
                      ))}
                      {debouncedSearch.trim() && searchResults.filter(u => !memberIds.has(u.id)).length === 0 && (
                        <p className="text-xs text-muted-400 px-2 py-1">No one new found</p>
                      )}
                    </div>
                  </div>
                )}

                <ul className="space-y-1">
                  {details.members.map(member => (
                    <li key={member.id} className="flex items-center gap-3 py-2">
                      <Avatar src={member.avatar} alt={member.name || member.username} size="md" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-muted-900 truncate">
                          {member.is_me ? 'You' : member.name || member.username}
                        </p>
                        <p className="text-xs text-muted-500 truncate">@{member.username}</p>
                      </div>
                      {member.role === 'admin' && (
                        <span className="px-2 py-0.5 text-[11px] font-semibold text-primary-700 bg-primary-50 rounded-full">Admin</span>
                      )}
                      {isAdmin && !member.is_me && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => setRole(member, member.role === 'admin' ? 'member' : 'admin')}
                            disabled={busy}
                            className="px-2 py-1 text-[11px] font-medium text-muted-600 hover:bg-muted-100 rounded-md"
                            title={member.role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}
                          >
                            {member.role === 'admin' ? 'Dismiss' : 'Make admin'}
                          </button>
                          <button
                            onClick={() => removeMember(member)}
                            disabled={busy}
                            className="p-1 hover:bg-accent-50 rounded-md"
                            title={`Remove ${member.username}`}
                            aria-label={`Remove ${member.username}`}
                          >
                            <Icon name="close" size={14} className="text-accent-500" />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Your own settings for this chat: notifications, archive, pin */}
            <section className="px-6 pt-4 space-y-2" aria-label="Chat settings">
              <label className="flex items-center justify-between gap-3 text-sm text-muted-800">
                <span>
                  Notifications
                  {muted && <span className="block text-xs text-muted-500">{mutedLabel}</span>}
                </span>
                <select
                  aria-label="Mute notifications"
                  value={muted ? 'muted' : ''}
                  onChange={(e) => dispatch(muteConversation(conversationId, (e.target.value || null) as '8h' | '1w' | 'always' | null))}
                  className="px-2 py-1.5 text-sm rounded-lg border border-muted-200 bg-white"
                >
                  <option value="">On</option>
                  {muted && <option value="muted" disabled>Muted</option>}
                  <option value="8h">Mute for 8 hours</option>
                  <option value="1w">Mute for 1 week</option>
                  <option value="always">Mute always</option>
                </select>
              </label>
              <div className="flex gap-2">
                {!prefs.isArchived && (
                  <button
                    onClick={() => dispatch(togglePinConversation(conversationId))}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-lg"
                  >
                    <Icon name="pin" size={16} /> {isPinned ? 'Unpin chat' : 'Pin chat'}
                  </button>
                )}
                <button
                  onClick={() => dispatch(archiveConversation(conversationId, !prefs.isArchived))}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-muted-700 bg-muted-100 hover:bg-muted-200 rounded-lg"
                >
                  {prefs.isArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                  {prefs.isArchived ? 'Unarchive chat' : 'Archive chat'}
                </button>
              </div>
            </section>

            <SafetyActions
              conversationId={conversationId}
              groupTitle={details.title}
              other={!isGroup && other ? { id: other.id, name: other.name || other.username } : null}
              isBlocked={isBlocked}
              onBlockedChange={(userId, blocked) => dispatch(setBlocked({ userId, blocked }))}
              onReport={setReporting}
            />

            {isGroup && (
              <div className="px-6 py-4">
                <button
                  onClick={leaveGroup}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-accent-600 bg-accent-50 hover:bg-accent-100 rounded-lg disabled:opacity-50"
                >
                  <Icon name="logout" size={16} /> Leave group
                </button>
              </div>
            )}
          </div>
        )}
        {reporting && <ReportDialog target={reporting} onClose={() => setReporting(null)} />}
        {showShared && (
          <SharedMedia conversationId={conversationId} currentUserId={me?.id} onBack={() => setShowShared(false)} />
        )}
      </aside>
    </div>
  );
};

/** Block or unblock (direct chats) and report (the person, or the group). */
const SafetyActions: React.FC<{
  conversationId: string;
  groupTitle?: string | null;
  other: { id: string; name: string } | null;
  isBlocked: boolean;
  onBlockedChange: (userId: string, blocked: boolean) => void;
  onReport: (target: ReportTarget) => void;
}> = ({ conversationId, groupTitle, other, isBlocked, onBlockedChange, onReport }) => {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const toggleBlock = async () => {
    if (!other) return;
    setBusy(true);
    try {
      if (isBlocked) await safetyService.unblock(other.id);
      else await safetyService.block(other.id);
      onBlockedChange(other.id, !isBlocked);
      toast.success(isBlocked ? `Unblocked ${other.name}` : `Blocked ${other.name}`);
      setConfirming(false);
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="px-6 pt-4 space-y-2" aria-label="Safety">
      {other && (
        confirming && !isBlocked ? (
          <div className="p-3 rounded-xl bg-accent-50 text-sm text-accent-800 space-y-2">
            <p>Block {other.name}? You won't be able to message each other directly, and they can't add you to groups. They aren't told. Groups you share and shared expenses stay as they are.</p>
            <div className="flex gap-2">
              <button onClick={toggleBlock} disabled={busy} className="flex-1 px-3 py-2 rounded-lg bg-accent-600 text-white font-semibold disabled:opacity-50">Block</button>
              <button onClick={() => setConfirming(false)} className="flex-1 px-3 py-2 rounded-lg bg-white text-muted-700 font-semibold">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => (isBlocked ? toggleBlock() : setConfirming(true))}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-accent-600 bg-accent-50 hover:bg-accent-100 rounded-lg disabled:opacity-50"
          >
            <Ban className="w-4 h-4" /> {isBlocked ? `Unblock ${other.name}` : `Block ${other.name}`}
          </button>
        )
      )}
      <button
        onClick={() => onReport(other
          ? { title: `Report ${other.name}`, userId: other.id, userName: other.name, conversationId }
          : { title: `Report ${groupTitle || 'this group'}`, conversationId })}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-muted-700 bg-muted-100 hover:bg-muted-200 rounded-lg"
      >
        <Flag className="w-4 h-4" /> {other ? `Report ${other.name}` : 'Report group'}
      </button>
    </section>
  );
};

export default ConversationInfoPanel;
