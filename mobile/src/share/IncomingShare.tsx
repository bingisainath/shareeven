// src/share/IncomingShare.tsx
// "Share to ShareEven" from the gallery or another app: pick chats, then send what was shared like any
// attachment (end-to-end encrypted where the chat is). The files arrive copied into the app's cache
// by the native side (android/.../ShareModule.kt).
import React, { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import ForwardSheet from '../components/chat/ForwardSheet';
import { showAlert } from '../components/common/Dialog';
import { ALLOWED, fileProblem } from '../api/media';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';

interface SharedFile { uri: string; type: string; name: string; size: number }
interface Shared { text?: string; files: SharedFile[] }

const native: { take(): Promise<Shared | null> } | undefined = NativeModules.ShareEvenShare;

const IncomingShare: React.FC<{ openChat: (conversationId: string) => void }> = ({ openChat }) => {
  const status = useAuth((s) => s.status);
  const me = useAuth((s) => s.user);
  const [shared, setShared] = useState<Shared | null>(null);

  useEffect(() => {
    if (status !== 'signedIn' || !native) return;
    const take = () => native.take()
      .then((s) => { if (s && (s.text || s.files.length)) setShared(s); })
      .catch(() => showAlert("Couldn't open what was shared", 'Try sharing it again.'));
    take();
    const sub = new NativeEventEmitter(NativeModules.ShareEvenShare).addListener('ShareEvenShared', take);
    return () => sub.remove();
  }, [status]);

  const send = (ids: string[]) => {
    if (!shared || !me) return;
    const { send: sendText, sendMedia } = useChat.getState();
    const skipped = new Map<string, string>(); // file name -> why it wasn't sent
    for (const conversationId of ids) {
      if (!shared.files.length) {
        if (shared.text) sendText(conversationId, shared.text, me);
        continue;
      }
      shared.files.forEach((f, n) => {
        // The same types and sizes as attaching in a chat (photos, videos, voice notes, PDF/Word)
        const problem = fileProblem(f.type, f.size);
        const kind = ALLOWED[f.type];
        if (problem || !kind) {
          skipped.set(f.name, problem || 'This file type is not supported');
          return;
        }
        sendMedia(conversationId, {
          file: { uri: f.uri, type: f.type, name: f.name },
          kind,
          caption: n === 0 ? shared.text || '' : '',
          quality: kind === 'file' ? 'original' : 'standard',
          size: f.size,
        }, me);
      });
    }
    setShared(null);
    if (skipped.size) showAlert("Some files weren't sent", Array.from(skipped, ([name, why]) => `${name}: ${why}`).join('\n'));
    if (ids.length === 1) openChat(ids[0]);
  };

  return <ForwardSheet visible={!!shared} title="Share to…" onClose={() => setShared(null)} onSend={send} />;
};

export default IncomingShare;
