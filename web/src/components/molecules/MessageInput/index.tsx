// src/components/molecules/MessageInput.tsx
// Message composer, modelled on WhatsApp:
// - Attach: "Photos & videos" (several at once, a caption on each, optional HD) or "Document" (sent as is)
// - Empty box shows a microphone: tap to record a voice note, then send or delete it
import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { chatDrafts } from '../../../utils/drafts';
import { toast } from 'react-toastify';
import { Check, FileText, Image as ImageIcon, Mic, Paperclip, Plus, ReceiptText, SendHorizontal, Smile, Trash2, X } from 'lucide-react';
import Icon from '../../atoms/Icon';
import EmojiPicker from '../EmojiPicker';
import { useVoiceRecorder } from '../../../hooks/useVoiceRecorder';
import { formatDuration, formatFileSize, mediaTypeOf, validateFile } from '../../../utils/media';
import type { UploadQuality } from '../../../utils/media';

const TOOL_BUTTON = 'p-2 rounded-lg text-primary-700 hover:bg-primary-50 transition-colors disabled:opacity-40';
const TYPING_REPEAT_MS = 2500;
const MAX_ATTACHMENTS = 10;
const VISUAL_TYPES = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime';

export interface OutgoingAttachment {
  file: File;
  caption: string;
  quality: UploadQuality;
}

interface Draft {
  id: string;
  file: File;
  previewUrl: string | null;
  caption: string;
  asDocument: boolean;
}

interface MessageInputProps {
  placeholder?: string;
  onSend: (message: string, attachments?: OutgoingAttachment[]) => void;
  onSendVoice?: (file: File, seconds: number) => void;
  onTyping?: (isTyping: boolean) => void;
  disabled?: boolean;
  /** The chat can't take messages (not end-to-end encrypted yet): only the expense button stays on. */
  messagesDisabled?: boolean;
  maxLength?: number;
  showAttachment?: boolean;
  showEmoji?: boolean;
  showExpense?: boolean; // For adding expense from chat
  onExpense?: () => void;
  className?: string;
  replyingTo?: { senderName?: string | null; text: string } | null;
  onCancelReply?: () => void;
  editingText?: string | null; // set while editing a sent message
  onCancelEdit?: () => void;
  /** Keeps unsent text for this chat (render with key={chatId} so each chat has its own box). */
  draftKey?: string;
}

let draftCounter = 0;

const MessageInput: React.FC<MessageInputProps> = ({
  placeholder = 'Type a message...',
  onSend,
  onSendVoice,
  onTyping,
  disabled: offline = false,
  messagesDisabled = false,
  maxLength = 5000,
  showAttachment = true,
  showEmoji = true,
  showExpense = false,
  onExpense,
  className = '',
  replyingTo = null,
  onCancelReply,
  editingText = null,
  draftKey,
  onCancelEdit
}) => {
  const disabled = offline || messagesDisabled; // expenses only need a connection
  const [message, setMessage] = useState(() => (draftKey ? chatDrafts.get(draftKey) : ''));
  const [isFocused, setIsFocused] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState(0);
  const [hd, setHd] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const isEditing = editingText !== null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTypingSentAt = useRef(0);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const recorder = useVoiceRecorder((file, seconds) => onSendVoice?.(file, seconds));
  useEffect(() => { if (recorder.error) toast.error(recorder.error); }, [recorder.error]);

  // Free preview object URLs when the composer goes away
  useEffect(() => () => draftsRef.current.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl)), []);

  // Keep what the person types as this chat's draft (not while editing a sent message)
  const rememberDraft = (text: string) => {
    if (draftKey && editingText === null) chatDrafts.set(draftKey, text);
  };

  // On a computer, the box is ready to type in when a chat opens (phones would pop the keyboard up)
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) textareaRef.current?.focus();
    requestAnimationFrame(adjustHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Entering edit mode loads the message text; leaving it brings back the unsent draft
  const editingStarted = useRef(false);
  useEffect(() => {
    if (editingText === null && !editingStarted.current) return; // first render: keep the draft
    editingStarted.current = editingText !== null;
    setMessage(editingText ?? (draftKey ? chatDrafts.get(draftKey) : ''));
    if (editingText !== null) {
      clearDrafts();
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingText]);

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  const clearDrafts = () => {
    draftsRef.current.forEach((d) => d.previewUrl && URL.revokeObjectURL(d.previewUrl));
    setDrafts([]);
    setSelected(0);
    setHd(false);
  };

  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? message.length;
    const end = textarea?.selectionEnd ?? message.length;
    const next = message.slice(0, start) + emoji + message.slice(end);
    if (next.length > maxLength) return;
    setMessage(next);
    rememberDraft(next);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  // Auto-resize textarea
  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length > maxLength) return;
    setMessage(value);
    rememberDraft(value);
    adjustHeight();
    if (!onTyping) return;
    // Repeat "typing" while the user keeps typing; receivers clear it if it stops arriving
    const now = Date.now();
    if (!isTyping || now - lastTypingSentAt.current > TYPING_REPEAT_MS) {
      setIsTyping(true);
      onTyping(true);
      lastTypingSentAt.current = now;
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      onTyping(false);
    }, 2000);
  };

  // With attachments the text box edits the caption of the selected one
  const selectDraft = (index: number) => {
    setDrafts((list) => list.map((d, i) => (i === selected ? { ...d, caption: message } : d)));
    setSelected(index);
    setMessage(drafts[index]?.caption || '');
    textareaRef.current?.focus();
  };

  const removeDraft = (index: number) => {
    const removed = drafts[index];
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    const rest = drafts.filter((_, i) => i !== index).map((d, i) => (i === selected ? { ...d, caption: message } : d));
    const next = Math.min(index === selected ? Math.max(0, index - 1) : selected > index ? selected - 1 : selected, rest.length - 1);
    setDrafts(rest);
    setSelected(Math.max(0, next));
    setMessage(index === selected ? rest[Math.max(0, next)]?.caption || '' : message);
  };

  const handleSend = () => {
    if (disabled) return;
    const trimmed = message.trim();
    if (drafts.length) {
      const list = drafts.map((d, i) => ({ ...d, caption: (i === selected ? message : d.caption).trim() }));
      onSend('', list.map((d) => ({
        file: d.file,
        caption: d.caption,
        quality: d.asDocument ? 'original' : hd ? 'hd' : 'standard',
      })));
      clearDrafts();
    } else if (trimmed || isEditing) {
      onSend(trimmed);
    } else {
      return;
    }
    setMessage('');
    if (draftKey && !isEditing) chatDrafts.set(draftKey, ''); // an edit leaves the draft alone
    setIsTyping(false);
    onTyping?.(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (drafts.length) clearDrafts();
      else if (isEditing) onCancelEdit?.();
      else if (replyingTo) onCancelReply?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const addFiles = (list: FileList | null, asDocument: boolean) => {
    setShowAttachMenu(false);
    if (!list?.length) return;
    const room = MAX_ATTACHMENTS - drafts.length;
    const picked = Array.from(list).slice(0, room);
    if (list.length > room) toast.info(`You can send up to ${MAX_ATTACHMENTS} at once`);
    const added: Draft[] = [];
    for (const file of picked) {
      const error = validateFile(file, asDocument);
      if (error) {
        toast.error(`${file.name}: ${error}`);
        continue;
      }
      const kind = mediaTypeOf(file);
      added.push({
        id: `d${++draftCounter}`,
        file,
        previewUrl: !asDocument && (kind === 'image' || kind === 'video') ? URL.createObjectURL(file) : null,
        caption: '',
        asDocument: asDocument || kind === 'file',
      });
    }
    if (!added.length) return;
    if (!drafts.length) setSelected(0);
    setDrafts((current) => [...current, ...added]);
    textareaRef.current?.focus();
  };

  const current = drafts[selected];
  const hasVisual = drafts.some((d) => !d.asDocument);
  const canSend = !disabled && (!!message.trim() || drafts.length > 0 || isEditing);
  const showMic = !!onSendVoice && !isEditing && !drafts.length && !message.trim();

  // ---- recording bar replaces the whole row
  if (recorder.state === 'recording') {
    return (
      <div className={`relative ${className}`}>
        <div className="flex items-center gap-3 h-11">
          <button type="button" onClick={() => recorder.stop(false)} className="p-2 rounded-lg text-accent-600 hover:bg-accent-50" title="Delete recording" aria-label="Delete recording">
            <Trash2 className="w-5 h-5" />
          </button>
          <div className="flex-1 flex items-center gap-3 px-4 h-11 rounded-xl border border-muted-200 bg-muted-50">
            <span className="w-2.5 h-2.5 rounded-full bg-accent-500" aria-hidden />
            <span className="text-sm font-medium tabular-nums text-muted-900" aria-live="polite">{formatDuration(recorder.seconds)}</span>
            <span className="text-sm text-muted-500 truncate">Recording voice message…</span>
          </div>
          <button
            type="button"
            onClick={() => recorder.stop(true)}
            className="flex-shrink-0 w-11 h-11 rounded-full bg-primary-700 hover:bg-primary-800 text-white flex items-center justify-center"
            title="Send voice message"
            aria-label="Send voice message"
          >
            <SendHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <input ref={mediaInputRef} type="file" accept={VISUAL_TYPES} multiple hidden onChange={(e) => { addFiles(e.target.files, false); e.target.value = ''; }} />
      <input ref={documentInputRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files, true); e.target.value = ''; }} />

      {/* Reply / edit banner */}
      {(isEditing || replyingTo) && (
        <div className="flex items-center gap-3 mb-2 pl-3 pr-1.5 py-2 bg-primary-50 border-l-4 border-primary-600 rounded-lg">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-primary-700">
              {isEditing ? 'Editing message' : `Replying to ${replyingTo?.senderName || 'message'}`}
            </p>
            {!isEditing && <p className="text-sm text-muted-600 truncate">{replyingTo?.text}</p>}
          </div>
          <button
            onClick={isEditing ? onCancelEdit : onCancelReply}
            className="p-1.5 hover:bg-primary-100 rounded-lg transition-colors"
            title={isEditing ? 'Cancel editing' : 'Cancel reply'}
          >
            <Icon name="close" size={16} className="text-muted-500" />
          </button>
        </div>
      )}

      {/* Attachments waiting to be sent: pick one to write its caption */}
      {drafts.length > 0 && (
        <div className="mb-2 p-2 rounded-xl border border-muted-200 bg-muted-50">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {drafts.map((d, i) => (
              <div key={d.id} className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => selectDraft(i)}
                  aria-label={`Attachment ${i + 1}: ${d.file.name}`}
                  aria-pressed={i === selected}
                  className={`block w-16 h-16 rounded-lg overflow-hidden border-2 ${i === selected ? 'border-primary-600' : 'border-transparent'}`}
                >
                  {d.previewUrl && mediaTypeOf(d.file) === 'image' && <img src={d.previewUrl} alt="" className="w-full h-full object-cover" />}
                  {d.previewUrl && mediaTypeOf(d.file) === 'video' && <video src={d.previewUrl} muted className="w-full h-full object-cover bg-black" />}
                  {!d.previewUrl && (
                    <span className="w-full h-full flex flex-col items-center justify-center bg-white text-primary-700">
                      <FileText className="w-6 h-6" strokeWidth={1.5} />
                      <span className="text-[9px] text-muted-500 px-1 truncate max-w-full">{d.file.name.split('.').pop()?.toUpperCase()}</span>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeDraft(i)}
                  aria-label={`Remove ${d.file.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted-800 text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {drafts.length < MAX_ATTACHMENTS && (
              <button
                type="button"
                onClick={() => (current?.asDocument ? documentInputRef : mediaInputRef).current?.click()}
                aria-label="Add more"
                className="flex-shrink-0 w-16 h-16 rounded-lg border-2 border-dashed border-muted-300 text-primary-700 flex items-center justify-center hover:border-primary-400"
              >
                <Plus className="w-5 h-5" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 mt-1 text-xs text-muted-500">
            <span className="truncate">
              {current?.file.name} · {formatFileSize(current?.file.size)}{current?.asDocument ? ' · sent as a document' : ''}
            </span>
            {hasVisual && (
              <button
                type="button"
                onClick={() => setHd((v) => !v)}
                aria-pressed={hd}
                title="HD keeps photos and videos at high resolution (bigger files)"
                className={`flex-shrink-0 px-2 py-0.5 rounded-md border font-semibold ${hd ? 'border-primary-600 bg-primary-700 text-white' : 'border-muted-300 bg-white text-muted-600'}`}
              >
                HD
              </button>
            )}
          </div>
        </div>
      )}

      {/* Input row: tools, text field, send / microphone */}
      <div className="flex items-end gap-2">
        <div className="flex items-center gap-0.5 pb-1">
          {showAttachment && !isEditing && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowAttachMenu((open) => !open)}
                disabled={disabled}
                className={TOOL_BUTTON}
                title="Attach"
                aria-label="Attach"
                aria-expanded={showAttachMenu}
              >
                <Paperclip className="w-5 h-5" strokeWidth={1.75} />
              </button>
              {showAttachMenu && (
                <div role="menu" className="absolute bottom-full left-0 mb-2 z-20 w-56 py-1 bg-white border border-muted-200 rounded-xl shadow-elevated">
                  <button type="button" role="menuitem" onClick={() => mediaInputRef.current?.click()} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left hover:bg-muted-50">
                    <ImageIcon className="w-5 h-5 text-primary-700" strokeWidth={1.75} />
                    <span><span className="block text-muted-900">Photos & videos</span><span className="block text-xs text-muted-500">Up to {MAX_ATTACHMENTS} at once</span></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => documentInputRef.current?.click()} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left hover:bg-muted-50">
                    <FileText className="w-5 h-5 text-primary-700" strokeWidth={1.75} />
                    <span><span className="block text-muted-900">Document</span><span className="block text-xs text-muted-500">Any file up to 150 MB, as is</span></span>
                  </button>
                </div>
              )}
            </div>
          )}

          {showEmoji && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowEmojiPicker(open => !open)}
                disabled={disabled}
                className={TOOL_BUTTON}
                title="Add emoji"
                aria-label="Add emoji"
              >
                <Smile className="w-5 h-5" strokeWidth={1.75} />
              </button>
              {showEmojiPicker && (
                <EmojiPicker
                  className="absolute bottom-full left-0 mb-2"
                  onSelect={insertEmoji}
                  onClose={() => setShowEmojiPicker(false)}
                />
              )}
            </div>
          )}

          {showExpense && !drafts.length && (
            <button
              type="button"
              onClick={onExpense}
              disabled={offline}
              className={TOOL_BUTTON}
              title="Add expense"
              aria-label="Add expense"
            >
              <ReceiptText className="w-5 h-5" strokeWidth={1.75} />
            </button>
          )}
        </div>

        <div
          className={`flex-1 min-w-0 flex items-end rounded-xl border bg-muted-50 transition-colors ${
            isFocused ? 'border-primary-500 bg-white ring-2 ring-primary-100' : 'border-muted-200'
          }`}
        >
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={isEditing ? 'Edit message…' : drafts.length ? 'Add a caption…' : placeholder}
            disabled={disabled}
            rows={1}
            aria-label="Message"
            className="flex-1 min-w-0 px-4 py-2.5 bg-transparent border-none outline-none resize-none text-[15px] leading-6 text-muted-900 placeholder:text-muted-400 disabled:opacity-50 max-h-[150px] overflow-y-auto"
            style={{ minHeight: '44px' }}
          />
        </div>

        {showMic ? (
          <button
            type="button"
            onClick={recorder.start}
            disabled={disabled}
            className="flex-shrink-0 w-11 h-11 rounded-full bg-primary-700 hover:bg-primary-800 text-white flex items-center justify-center transition-colors disabled:bg-muted-300"
            title="Record a voice message"
            aria-label="Record voice message"
          >
            <Mic className="w-5 h-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="flex-shrink-0 w-11 h-11 rounded-full bg-primary-700 hover:bg-primary-800 text-white flex items-center justify-center transition-colors disabled:bg-muted-300 disabled:cursor-not-allowed"
            title={isEditing ? 'Save' : drafts.length > 1 ? `Send ${drafts.length}` : 'Send'}
            aria-label={isEditing ? 'Save' : 'Send'}
          >
            {isEditing ? <Check className="w-5 h-5" /> : <SendHorizontal className="w-5 h-5" />}
          </button>
        )}
      </div>

      {/* Character counter */}
      {message.length > maxLength * 0.8 && (
        <div className="pt-1 text-right">
          <span className={`text-xs ${message.length >= maxLength ? 'text-accent-600' : 'text-muted-400'}`}>
            {message.length}/{maxLength}
          </span>
        </div>
      )}
    </div>
  );
};

export default MessageInput;
