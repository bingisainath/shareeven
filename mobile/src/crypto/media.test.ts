// Streaming encryption of files on the phone (crypto/media.ts), with react-native-blob-util replaced
// by an in-memory file system that reads in the same base64 pieces the real one does.

import { decryptFile, encryptFile, FILE_CHUNK, fromBase64, toBase64 } from './e2e';

const mockFiles = new Map<string, Uint8Array>();
const mockServer: { body: Uint8Array } = { body: new Uint8Array(0) };

const mockConcat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

jest.mock('react-native-blob-util', () => {
  const { fromBase64: fromB64, toBase64: toB64 } = jest.requireActual('./e2e');
  const fs = {
    dirs: { CacheDir: '/cache', DocumentDir: '/docs', DownloadDir: '/downloads' },
    isDir: async (p: string) => p === '/cache/e2e' || [...mockFiles.keys()].some((k) => k.startsWith(`${p}/`)),
    mkdir: async () => undefined,
    exists: async (p: string) => mockFiles.has(p),
    stat: async (p: string) => ({ size: mockFiles.get(p)!.length }),
    unlink: async (p: string) => { mockFiles.delete(p); },
    mv: async (from: string, to: string) => { mockFiles.set(to, mockFiles.get(from)!); mockFiles.delete(from); },
    cp: async (from: string, to: string) => { mockFiles.set(to, mockFiles.get(from)!); },
    readFile: async (p: string) => toB64(mockFiles.get(p)!),
    writeFile: async (p: string, data: string) => { mockFiles.set(p, fromB64(data)); },
    writeStream: async (p: string) => {
      mockFiles.set(p, new Uint8Array(0));
      return { write: async (data: string) => { mockFiles.set(p, mockConcat(mockFiles.get(p)!, fromB64(data))); }, close: async () => undefined };
    },
    readStream: async (p: string, _encoding: string, bufferSize: number) => {
      const handlers: Record<string, (x?: any) => void> = {};
      return {
        onData: (fn: (chunk: string) => void) => { handlers.data = fn; },
        onError: (fn: () => void) => { handlers.error = fn; },
        onEnd: (fn: () => void) => { handlers.end = fn; },
        open: () => {
          const bytes = mockFiles.get(p)!;
          // like the native module: base64 pieces of bufferSize bytes, delivered asynchronously
          setTimeout(() => {
            for (let i = 0; i < bytes.length; i += bufferSize) handlers.data(toB64(bytes.subarray(i, i + bufferSize)));
            handlers.end();
          }, 0);
        },
      };
    },
  };
  return {
    __esModule: true,
    default: {
      fs,
      config: ({ path }: { path: string }) => ({
        fetch: async () => {
          mockFiles.set(path, mockServer.body);
          return { info: () => ({ status: 200 }) };
        },
      }),
    },
  };
});
jest.mock('../config', () => ({ mediaUrl: (u: string) => u }));

import { decryptedFile, encryptFileV2, encryptForUpload, rememberDecrypted, useMediaSrc } from './media';

// Jest's toEqual on multi-megabyte arrays enumerates every index as a string key: compare directly
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

const sample = (size: number) => new Uint8Array(size).map((_, i) => (i * 7 + 3) & 255);

describe('encrypting files for upload', () => {
  it.each([0, 10, FILE_CHUNK, 3 * FILE_CHUNK + 5])('small file of %i bytes (in one go)', async (size) => {
    mockFiles.set('/pics/a.bin', sample(size));
    const { uri, key, size: plainSize } = await encryptForUpload({ uri: 'file:///pics/a.bin', type: 'video/mp4' });
    expect(plainSize).toBe(size);
    expect(same(decryptFile(fromBase64(key), mockFiles.get(uri.replace('file://', ''))!), sample(size))).toBe(true);
  });

  it.each([8 * 1024 * 1024 + 1, 9 * FILE_CHUNK * 16])('large file of %i bytes (streamed in pieces)', async (size) => {
    mockFiles.set('/pics/big.mp4', sample(size));
    const { uri, key } = await encryptForUpload({ uri: 'file:///pics/big.mp4', type: 'video/mp4' });
    expect(same(decryptFile(fromBase64(key), mockFiles.get(uri.replace('file://', ''))!), sample(size))).toBe(true);
  }, 60000);

  it('removes location/camera data from upright JPEG photos', async () => {
    const exif = [0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0]; // APP1 "Exif" (no orientation)
    const jpeg = new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xda, 1, 2, 3]);
    mockFiles.set('/pics/p.jpg', jpeg);
    const { uri, key } = await encryptForUpload({ uri: 'file:///pics/p.jpg', type: 'image/jpeg' });
    expect(Array.from(decryptFile(fromBase64(key), mockFiles.get(uri.replace('file://', ''))!))).toEqual([0xff, 0xd8, 0xff, 0xda, 1, 2, 3]);
  });
});

describe('decrypting downloads', () => {
  const key = new Uint8Array(32).fill(9);

  it.each([0, 1, FILE_CHUNK, FILE_CHUNK + 1, 8 * 1024 * 1024 + 17])('round-trips %i bytes through the cache', async (size) => {
    mockServer.body = encryptFile(key, sample(size));
    const uri = await decryptedFile(`/api/v1/media/x${size}.enc?sig=1`, toBase64(key), 'video/mp4');
    expect(uri).toMatch(/^file:\/\/\/cache\/e2e\/[0-9a-f]{32}\.mp4$/);
    expect(same(mockFiles.get(uri.replace('file://', '')), sample(size))).toBe(true);
    // The download and the partial file are gone; asking again reuses the decrypted copy
    expect([...mockFiles.keys()].some((k) => k.endsWith('.download') || k.endsWith('.part'))).toBe(false);
    mockServer.body = new Uint8Array(0);
    expect(await decryptedFile(`/api/v1/media/x${size}.enc?sig=2`, toBase64(key), 'video/mp4')).toBe(uri);
  }, 60000);

  it('refuses an altered file and leaves nothing behind', async () => {
    mockServer.body = encryptFile(key, sample(3 * FILE_CHUNK));
    mockServer.body[100] ^= 1;
    await expect(decryptedFile('/api/v1/media/bad.enc', toBase64(key), 'image/jpeg')).rejects.toThrow();
    expect([...mockFiles.keys()].some((k) => k.includes('/cache/e2e/') && !k.includes('/up-') && k.endsWith('.jpg'))).toBe(false);
  });
});

describe('v2 (PMV2) files', () => {
  it.each([10, 3 * FILE_CHUNK + 5, 8 * 1024 * 1024 + 3])('encrypt %i bytes from disk, then download and decrypt them', async (size) => {
    mockFiles.set('/pics/v2.bin', sample(size));
    const sealed = await encryptFileV2({ uri: 'file:///pics/v2.bin', type: 'video/mp4' });
    expect(sealed.size).toBe(size);
    mockServer.body = mockFiles.get(sealed.uri.replace('file://', ''))!;
    const uri = await decryptedFile(`/api/v1/media/v2-${size}.enc`, sealed.key, 'video/mp4', { sha256: sealed.sha256, size: sealed.size });
    expect(same(mockFiles.get(uri.replace('file://', '')), sample(size))).toBe(true);
  }, 60000);

  it('a changed v2 file is refused', async () => {
    mockFiles.set('/pics/v2b.bin', sample(1000));
    const sealed = await encryptFileV2({ uri: 'file:///pics/v2b.bin', type: 'image/png' });
    mockServer.body = mockFiles.get(sealed.uri.replace('file://', ''))!.slice();
    mockServer.body[30] ^= 1;
    await expect(decryptedFile('/api/v1/media/v2-bad.enc', sealed.key, 'image/png', { sha256: sealed.sha256, size: sealed.size })).rejects.toThrow();
  });
});

describe('a photo we just sent', () => {
  it("shows on its bubble's first frame once it has the server's address (no blink)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require('react');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { create, act } = require('react-test-renderer');
    mockFiles.set('/picked/IMG_1.jpg', new Uint8Array([1, 2, 3]));
    const seen: (string | undefined)[] = [];
    const Bubble = ({ url }: { url: string }) => {
      seen.push(useMediaSrc(url, 'k3y', 'image/jpeg').src);
      return null;
    };
    await rememberDecrypted('/api/v1/media/chat/sent.enc', 'k3y', 'file:///picked/IMG_1.jpg', 'image/jpeg');
    act(() => { create(React.createElement(Bubble, { url: '/api/v1/media/chat/sent.enc?exp=1&sig=s' })); });
    // the very first render already has it, and it's the same file the sending bubble showed
    expect(seen[0]).toBe('file:///picked/IMG_1.jpg');
  });
});
