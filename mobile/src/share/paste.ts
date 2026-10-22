// src/share/paste.ts
// Images and files pasted into the chat's message box (Android: long-press → Paste, or the keyboard's
// clipboard and image suggestions). The native side (android/.../PasteModule.kt) watches the TextInput
// whose nativeID is MESSAGE_INPUT_ID and hands over copies in the app's cache; text pastes as usual.
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { ALLOWED, fileProblem, kindOf } from '../api/media';
import type { UploadQuality } from '../api/media';
import type { Attachment } from '../store/chat';

export const MESSAGE_INPUT_ID = 'message-input';

export interface PastedFile { uri: string; type: string; name: string; size: number }

/** Listen for pasted files while a message box is on screen. Returns the unsubscribe function. */
export function onPastedFiles(listener: (files: PastedFile[]) => void): () => void {
  const native: { enable(): void } | undefined = NativeModules.ShareEvenPaste;
  if (Platform.OS !== 'android' || !native) return () => undefined;
  native.enable();
  const sub = new NativeEventEmitter(NativeModules.ShareEvenPaste)
    .addListener('ShareEvenPasted', (event: { files?: PastedFile[] }) => listener(event?.files || []));
  return () => sub.remove();
}

/**
 * A pasted file as an attachment: photos and videos as media (shrunk like gallery picks), anything
 * else as a document. Returns the reason instead when it can't be sent.
 */
export function pastedAttachment(file: PastedFile): Attachment | { problem: string } {
  const visual = ALLOWED[file.type] === 'image' || ALLOWED[file.type] === 'video';
  const problem = fileProblem(file.type, file.size, !visual);
  if (problem) return { problem };
  return {
    file: { uri: file.uri, type: file.type, name: file.name },
    kind: visual ? ALLOWED[file.type] : kindOf(file.type, true)!,
    caption: '',
    quality: (visual ? 'standard' : 'original') as UploadQuality,
    size: file.size || undefined,
  };
}
