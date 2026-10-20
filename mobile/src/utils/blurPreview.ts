// src/utils/blurPreview.ts
// The tiny preview sent inside an encrypted photo's pointer (MediaPointer.blur): a ~24 px JPEG,
// about 1 KB, shown blurred while the real photo downloads and decrypts (like WhatsApp).
// It travels inside the encrypted message, so the server never sees it.

import ImageResizer from '@bam.tech/react-native-image-resizer';
import ReactNativeBlobUtil from 'react-native-blob-util';

const SIDE = 24;
const MAX_B64 = 3000; // a bigger "preview" isn't worth sending

/** base64 JPEG preview of a local photo, or undefined when it can't be made (the photo still sends). */
export async function blurPreview(uri: string): Promise<string | undefined> {
  let path: string | undefined;
  try {
    const small = await ImageResizer.createResizedImage(uri, SIDE, SIDE, 'JPEG', 40, 0, null, false, { mode: 'contain', onlyScaleDown: false });
    path = small.path || small.uri.replace(/^file:\/\//, '');
    const b64 = await ReactNativeBlobUtil.fs.readFile(path, 'base64');
    return b64 && b64.length <= MAX_B64 ? b64 : undefined;
  } catch {
    return undefined;
  } finally {
    if (path) ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined);
  }
}

export const blurUri = (b64?: string) => (b64 ? `data:image/jpeg;base64,${b64}` : undefined);
