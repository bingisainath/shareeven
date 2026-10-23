import { formatFileSize, mediaBoxStyle, messagePreview, resolveMediaUrl, validateFile, withExtension } from './media';

const fileOf = (type: string, size: number, name = 'f') =>
  new File([new Uint8Array(1)], name, { type }) as File & { size: number };

const sized = (type: string, size: number) => {
  const file = fileOf(type, size);
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('validateFile', () => {
  it('accepts supported files within limits', () => {
    expect(validateFile(sized('image/png', 1024))).toBeNull();
    expect(validateFile(sized('video/mp4', 40 * 1024 * 1024))).toBeNull();
  });

  it('rejects unsupported types and oversized files', () => {
    expect(validateFile(sized('text/html', 10))).toMatch(/not supported/);
    expect(validateFile(sized('image/png', 11 * 1024 * 1024))).toMatch(/too large/);
    expect(validateFile(sized('video/mp4', 51 * 1024 * 1024))).toMatch(/max 50MB/);
  });

  it('takes any file as a document, up to 150MB', () => {
    expect(validateFile(sized('application/vnd.android.package-archive', 120 * 1024 * 1024), true)).toBeNull();
    expect(validateFile(sized('', 1024), true)).toBeNull();
    expect(validateFile(sized('application/zip', 151 * 1024 * 1024), true)).toMatch(/max 150MB/);
  });
});

describe('mediaBoxStyle', () => {
  it('takes the picture\'s shape: wide ones full width, tall ones full height', () => {
    expect(mediaBoxStyle(400, 300)).toEqual({ width: 300, height: 225 });
    expect(mediaBoxStyle(300, 400)).toEqual({ width: 255, height: 340 });
  });

  it('crops only very thin or very wide pictures', () => {
    expect(mediaBoxStyle(100, 1000)).toEqual({ width: 160, height: 340 });
    expect(mediaBoxStyle(1000, 100)).toEqual({ width: 300, height: 120 });
  });

  it('returns nothing without dimensions', () => {
    expect(mediaBoxStyle(undefined, 300)).toBeUndefined();
  });
});

describe('messagePreview', () => {
  it('prefers text, then describes the media', () => {
    expect(messagePreview('hi', 'image')).toBe('hi');
    expect(messagePreview('', 'image')).toBe('Photo');
    expect(messagePreview('', 'video')).toBe('Video');
    expect(messagePreview('', 'file', 'cv.pdf')).toBe('cv.pdf');
  });
});

describe('resolveMediaUrl', () => {
  it('prefixes server-relative URLs with the API base', () => {
    expect(resolveMediaUrl('/api/v1/media/a.png?sig=1')).toMatch(/^https?:\/\/.+\/api\/v1\/media\/a\.png\?sig=1$/);
    expect(resolveMediaUrl('blob:http://x/1')).toBe('blob:http://x/1');
    expect(resolveMediaUrl(null)).toBeUndefined();
  });
});

describe('formatFileSize', () => {
  it('uses readable units', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('withExtension', () => {
  it('adds the extension of the file type to a name without one', () => {
    expect(withExtension('ShareEven photo', 'image/png')).toBe('ShareEven photo.png');
    expect(withExtension('ShareEven video', 'video/quicktime')).toBe('ShareEven video.mov');
  });
  it('keeps a name that already has one', () => {
    expect(withExtension('holiday.jpeg', 'image/png')).toBe('holiday.jpeg');
  });
  it("uses the address's extension when the type isn't known, but never .enc", () => {
    expect(withExtension('Receipt 1', undefined, '/api/v1/media/receipts/ab.jpg?exp=1&sig=x')).toBe('Receipt 1.jpg');
    expect(withExtension('photo', undefined, '/api/v1/media/chat/ab.enc?exp=1')).toBe('photo');
  });
});
