// src/utils/save.ts
// Save a chat's photo, video, voice note or document to the phone.
// Android: photos go to Pictures/ShareEven and videos to Movies/ShareEven (both show in Gallery),
// everything else to Downloads. iPhone: opens the file's preview, whose share button offers
// "Save Image", "Save to Files", etc.
import { PermissionsAndroid, Platform, ToastAndroid } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { mediaUrl } from '../config';
import { decryptedFile, watchProgress } from '../crypto/media';
import { downloadKey, useDownloads } from '../store/downloads';
import { showAlert } from '../components/common/Dialog';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4', weba: 'audio/webm',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Where a saved file ended up: Gallery, Downloads, or (iPhone) a preview the person saves from. */
export type SavedTo = 'gallery' | 'downloads' | 'preview';

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'shareeven-file';
const extension = (name: string) => (/\.([a-z0-9]{2,5})$/i.exec(name)?.[1] || '').toLowerCase();

/** "photo" saved as image/png becomes "photo.png", so Gallery and file managers know what it is. */
export function withExtension(name: string, mime: string): string {
  if (extension(name)) return name;
  const ext = Object.keys(MIME).find((e) => MIME[e] === mime);
  return ext ? `${name}.${ext}` : name;
}

/** The file's type: as sent, else from its name or address. */
export function mimeOf(filename: string, url?: string, given?: string): string {
  return given || MIME[extension(filename)] || MIME[extension((url || '').split('?')[0])] || 'application/octet-stream';
}

/** Android 9 and older write to shared folders directly, which needs the storage permission. */
async function ensureStoragePermission() {
  if (Platform.OS !== 'android' || Number(Platform.Version) >= 29) return;
  const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
  if (await PermissionsAndroid.check(permission)) return;
  if ((await PermissionsAndroid.request(permission)) !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new StoragePermissionError();
  }
}

export class StoragePermissionError extends Error {
  constructor() {
    super('Storage permission denied');
  }
}

/** Copy a file already on the phone to Gallery or Downloads (Android) or open its preview to save or share it (iPhone). */
export async function saveLocalFile(local: string, filename: string, mime: string): Promise<SavedTo> {
  const name = withExtension(safeName(filename), mime);
  const path = local.replace(/^file:\/\//, '');
  if (Platform.OS === 'android') {
    await ensureStoragePermission();
    const gallery = mime.startsWith('image/') || mime.startsWith('video/');
    const collection = mime.startsWith('image/') ? 'Image' : mime.startsWith('video/') ? 'Video' : 'Download';
    // Android 9 and older: react-native-blob-util joins the folder to Pictures/Movies without a "/"
    const folder = !gallery ? '' : Number(Platform.Version) >= 29 ? 'ShareEven' : '/ShareEven';
    const saved = await ReactNativeBlobUtil.MediaCollection.copyToMediaStore({ name, parentFolder: folder, mimeType: mime }, collection, path);
    // Android 9 and older: a plain file, which Gallery only lists once it's been scanned
    if (Number(Platform.Version) < 29 && saved) {
      await ReactNativeBlobUtil.fs.scanFile([{ path: saved.replace(/^file:\/\//, ''), mime }]).catch(() => undefined);
    }
    return gallery ? 'gallery' : 'downloads';
  }
  const target = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${name}`;
  await ReactNativeBlobUtil.fs.unlink(target).catch(() => undefined);
  await ReactNativeBlobUtil.fs.cp(path, target);
  await ReactNativeBlobUtil.ios.openDocument(target);
  return 'preview';
}

/** key/mime: end-to-end encrypted files are decrypted on the phone, then saved. Plain files (receipts, older media) are downloaded first. */
export async function saveToPhone(
  url: string, filename: string, key?: string, fileMime?: string, v2?: { sha256: string; size: number }, onProgress?: (fraction: number) => void,
): Promise<SavedTo> {
  const mime = mimeOf(filename, url, fileMime);
  if (key) {
    const local = await decryptedFile(url, key, fileMime, v2, onProgress);
    return saveLocalFile(local, filename, mime);
  }
  if (/^file:\/\//.test(url)) return saveLocalFile(url, filename, mime);
  const task = ReactNativeBlobUtil.config({ fileCache: true }).fetch('GET', mediaUrl(url)!);
  if (onProgress) watchProgress(task, onProgress);
  const download = await task;
  try {
    if (download.info().status !== 200) throw new Error(`Download failed (${download.info().status})`);
    return await saveLocalFile(download.path(), filename, mime);
  } finally {
    await ReactNativeBlobUtil.fs.unlink(download.path()).catch(() => undefined);
  }
}

/**
 * Save, showing how far the download has got (the file's bubble, its button and the bar at the
 * bottom of the screen follow it in store/downloads), then say where it went or why it couldn't.
 * Tapping Save again while it's still downloading does nothing.
 */
export async function saveWithFeedback(url: string, filename: string, key?: string, fileMime?: string, v2?: { sha256: string; size: number }): Promise<void> {
  const downloads = useDownloads.getState();
  const id = downloadKey(url);
  if (downloads.active.some((d) => d.key === id)) return;
  downloads.start(id, withExtension(safeName(filename), mimeOf(filename, url, fileMime)));
  try {
    const to = await saveToPhone(url, filename, key, fileMime, v2, (fraction) => useDownloads.getState().progress(id, fraction));
    if (Platform.OS === 'android' && to !== 'preview') {
      ToastAndroid.show(to === 'gallery' ? 'Saved to Gallery' : 'Saved to Downloads', ToastAndroid.SHORT);
    }
  } catch (e) {
    if (e instanceof StoragePermissionError) {
      showAlert("Couldn't save it", 'ShareEven needs permission to save files. Allow it in Settings → Apps → ShareEven → Permissions.');
    } else {
      console.warn('[save] failed:', (e as Error)?.message || e);
      showAlert("Couldn't save it", 'Check your connection and try again.');
    }
  } finally {
    useDownloads.getState().finish(id);
  }
}
