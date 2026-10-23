import { PermissionsAndroid, Platform, ToastAndroid } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { showAlert } from '../components/common/Dialog';
import { mimeOf, saveToPhone, saveWithFeedback, StoragePermissionError, withExtension } from './save';

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: { dirs: { DocumentDir: '/docs' }, unlink: jest.fn(async () => undefined), scanFile: jest.fn(async () => undefined), cp: jest.fn() },
    MediaCollection: { copyToMediaStore: jest.fn(async () => 'content://media/1') },
    config: jest.fn(),
  },
}));
jest.mock('../crypto/media', () => ({ decryptedFile: jest.fn(async () => 'file:///cache/e2e/abc.jpg'), watchProgress: jest.fn() }));
jest.mock('../config', () => ({ mediaUrl: (u: string) => `https://api.test${u}` }));

const blob = ReactNativeBlobUtil as unknown as {
  fs: { unlink: jest.Mock; scanFile: jest.Mock };
  MediaCollection: { copyToMediaStore: jest.Mock };
  config: jest.Mock;
};
const androidVersion = (v: number) => {
  Platform.OS = 'android';
  Object.defineProperty(Platform, 'Version', { get: () => v, configurable: true });
};

beforeEach(() => {
  jest.clearAllMocks();
  androidVersion(34);
});

describe('save names', () => {
  it('adds the extension of the type to a name without one', () => {
    expect(withExtension('ShareEven photo', 'image/png')).toBe('ShareEven photo.png');
    expect(withExtension('ShareEven video-1a2b3c4d', 'video/mp4')).toBe('ShareEven video-1a2b3c4d.mp4');
    expect(withExtension('IMG_1234.JPG', 'image/png')).toBe('IMG_1234.JPG');
  });
  it('finds the type from the name, then the address', () => {
    expect(mimeOf('a.pdf')).toBe('application/pdf');
    expect(mimeOf('Receipt 1', '/api/v1/media/receipts/x.jpg?exp=1')).toBe('image/jpeg');
    expect(mimeOf('a.png', undefined, 'image/webp')).toBe('image/webp');
    expect(mimeOf('Receipt 1', '/x')).toBe('application/octet-stream');
  });
});

describe('saveToPhone on Android', () => {
  it('puts an encrypted photo in Pictures/ShareEven (Gallery), decrypted', async () => {
    await expect(saveToPhone('/api/v1/media/c/x.enc', 'ShareEven photo', 'key', 'image/jpeg')).resolves.toBe('gallery');
    expect(blob.MediaCollection.copyToMediaStore).toHaveBeenCalledWith(
      { name: 'ShareEven photo.jpg', parentFolder: 'ShareEven', mimeType: 'image/jpeg' }, 'Image', '/cache/e2e/abc.jpg');
  });

  it('puts videos in Movies/ShareEven and documents in Downloads', async () => {
    await saveToPhone('/v.enc', 'clip', 'key', 'video/mp4');
    expect(blob.MediaCollection.copyToMediaStore).toHaveBeenLastCalledWith(expect.objectContaining({ parentFolder: 'ShareEven' }), 'Video', expect.any(String));
    await expect(saveToPhone('/d.enc', 'report.pdf', 'key', 'application/pdf')).resolves.toBe('downloads');
    expect(blob.MediaCollection.copyToMediaStore).toHaveBeenLastCalledWith(expect.objectContaining({ parentFolder: '' }), 'Download', expect.any(String));
  });

  it('downloads a plain file (a receipt) first, then removes the temporary copy', async () => {
    const fetch = jest.fn(async () => ({ info: () => ({ status: 200 }), path: () => '/cache/tmp123' }));
    blob.config.mockReturnValue({ fetch });
    await expect(saveToPhone('/api/v1/media/receipts/r.jpg?sig=1', 'Receipt 1')).resolves.toBe('gallery');
    expect(fetch).toHaveBeenCalledWith('GET', 'https://api.test/api/v1/media/receipts/r.jpg?sig=1');
    expect(blob.MediaCollection.copyToMediaStore).toHaveBeenCalledWith(
      { name: 'Receipt 1.jpg', parentFolder: 'ShareEven', mimeType: 'image/jpeg' }, 'Image', '/cache/tmp123');
    expect(blob.fs.unlink).toHaveBeenCalledWith('/cache/tmp123');
  });

  it("doesn't save an error page when the download fails", async () => {
    blob.config.mockReturnValue({ fetch: jest.fn(async () => ({ info: () => ({ status: 403 }), path: () => '/cache/tmp9' })) });
    await expect(saveToPhone('/r.jpg', 'r.jpg')).rejects.toThrow('403');
    expect(blob.MediaCollection.copyToMediaStore).not.toHaveBeenCalled();
    expect(blob.fs.unlink).toHaveBeenCalledWith('/cache/tmp9');
  });

  it('Android 9 and older: asks for storage permission, works around the folder path, and scans the file', async () => {
    androidVersion(28);
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    blob.MediaCollection.copyToMediaStore.mockResolvedValueOnce('file:///storage/emulated/0/Pictures/ShareEven/p.jpg');
    await saveToPhone('/x.enc', 'p', 'key', 'image/jpeg');
    expect(PermissionsAndroid.request).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    expect(blob.MediaCollection.copyToMediaStore).toHaveBeenCalledWith(expect.objectContaining({ parentFolder: '/ShareEven' }), 'Image', expect.any(String));
    expect(blob.fs.scanFile).toHaveBeenCalledWith([{ path: '/storage/emulated/0/Pictures/ShareEven/p.jpg', mime: 'image/jpeg' }]);
  });

  it('Android 9 and older: permission refused', async () => {
    androidVersion(26);
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    await expect(saveToPhone('/x.enc', 'p', 'key', 'image/jpeg')).rejects.toBeInstanceOf(StoragePermissionError);
    expect(blob.MediaCollection.copyToMediaStore).not.toHaveBeenCalled();
  });
});

describe('saveWithFeedback', () => {
  it('says where it was saved', async () => {
    const toast = jest.spyOn(ToastAndroid, 'show').mockImplementation(() => undefined);
    await saveWithFeedback('/x.enc', 'p', 'key', 'image/jpeg');
    expect(toast).toHaveBeenCalledWith('Saved to Gallery', ToastAndroid.SHORT);
    await saveWithFeedback('/x.enc', 'a.pdf', 'key', 'application/pdf');
    expect(toast).toHaveBeenLastCalledWith('Saved to Downloads', ToastAndroid.SHORT);
  });

  it('explains a refused permission, and a failed save', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    androidVersion(28);
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    await saveWithFeedback('/x.enc', 'p', 'key', 'image/jpeg');
    expect(showAlert).toHaveBeenLastCalledWith("Couldn't save it", expect.stringContaining('permission'));
    androidVersion(34);
    blob.MediaCollection.copyToMediaStore.mockRejectedValueOnce(new Error('disk full'));
    await saveWithFeedback('/x.enc', 'p', 'key', 'image/jpeg');
    expect(showAlert).toHaveBeenLastCalledWith("Couldn't save it", 'Check your connection and try again.');
  });
});

describe('download progress', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useDownloads } = require('../store/downloads');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decryptedFile } = require('../crypto/media');

  it('shows the file downloading, with how far, until it is saved', async () => {
    jest.spyOn(ToastAndroid, 'show').mockImplementation(() => undefined);
    let report: (f: number) => void = () => undefined;
    let finishDownload: (uri: string) => void = () => undefined;
    decryptedFile.mockImplementationOnce((_u: string, _k: string, _m: string, _v: unknown, onProgress: (f: number) => void) => {
      report = onProgress;
      return new Promise((resolve) => { finishDownload = resolve; });
    });
    const saving = saveWithFeedback('/api/v1/media/c/big.enc?exp=1&sig=s', 'Report Q3', 'key', 'application/pdf');
    await Promise.resolve();
    expect(useDownloads.getState().active).toEqual([{ key: '/api/v1/media/c/big.enc', name: 'Report Q3.pdf' }]);
    report(0.42);
    expect(useDownloads.getState().active[0].progress).toBe(0.42);
    // tapping Save again while it downloads doesn't start a second one
    await saveWithFeedback('/api/v1/media/c/big.enc?exp=2&sig=t', 'Report Q3', 'key', 'application/pdf');
    expect(decryptedFile).toHaveBeenCalledTimes(1);
    finishDownload('file:///cache/e2e/big.pdf');
    await saving;
    expect(useDownloads.getState().active).toEqual([]);
    expect(ToastAndroid.show).toHaveBeenCalledWith('Saved to Downloads', ToastAndroid.SHORT);
  });

  it('clears the progress when it fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    decryptedFile.mockRejectedValueOnce(new Error('offline'));
    await saveWithFeedback('/x.enc', 'a.pdf', 'key', 'application/pdf');
    expect(useDownloads.getState().active).toEqual([]);
    expect(showAlert).toHaveBeenLastCalledWith("Couldn't save it", 'Check your connection and try again.');
  });
});
