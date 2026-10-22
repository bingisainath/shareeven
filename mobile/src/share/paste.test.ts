import { NativeModules, Platform } from 'react-native';
import { onPastedFiles, pastedAttachment } from './paste';

const MB = 1024 * 1024;

it('a pasted screenshot is a photo, shrunk like gallery picks', () => {
  expect(pastedAttachment({ uri: 'file:///cache/pasted/a.png', type: 'image/png', name: 'Screenshot.png', size: 200000 })).toEqual({
    file: { uri: 'file:///cache/pasted/a.png', type: 'image/png', name: 'Screenshot.png' },
    kind: 'image', caption: '', quality: 'standard', size: 200000,
  });
});

it('a pasted PDF or zip is a document, sent as it is', () => {
  expect(pastedAttachment({ uri: 'file:///b.pdf', type: 'application/pdf', name: 'bill.pdf', size: MB })).toMatchObject({ kind: 'file', quality: 'original' });
  expect(pastedAttachment({ uri: 'file:///c.zip', type: 'application/zip', name: 'c.zip', size: MB })).toMatchObject({ kind: 'file', quality: 'original' });
});

it('too large is refused with the reason', () => {
  expect(pastedAttachment({ uri: 'file:///big.png', type: 'image/png', name: 'big.png', size: 40 * MB })).toEqual({ problem: 'Too large (max 10 MB)' });
});

it('turns the native side on (Android only)', () => {
  const enable = jest.fn();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  (NativeModules as any).ShareEvenPaste = { enable, addListener: jest.fn(), removeListeners: jest.fn() };
  const stop = onPastedFiles(jest.fn());
  expect(enable).toHaveBeenCalled();
  stop();
});
