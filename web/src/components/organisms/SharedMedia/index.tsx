// src/components/organisms/SharedMedia/index.tsx
// "Media, links and docs" from chat info: everything shared in the conversation, newest first.

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, ExternalLink, FileText, Link2, Loader2, Play } from 'lucide-react';
import { toast } from 'react-toastify';
import api from '../../../utils/axios';
import { parseApiError } from '../../../utils/apiError';
import { downloadMedia, formatDuration, formatFileSize, resolveMediaUrl } from '../../../utils/media';
import VoiceNotePlayer from '../../molecules/VoiceNotePlayer';
import MediaViewer from '../MediaViewer';
import type { ViewerImage } from '../MediaViewer';
import { openText } from '../../../crypto/messages';
import { downloadDecrypted, useMediaSrc } from '../../../crypto/media';
import { isV2Marker, localFor } from '../../../crypto/v2-platform/chat';

export type SharedKind = 'media' | 'docs' | 'links';

export interface SharedItem {
  message_id: string;
  sender_id: string;
  sender_name?: string | null;
  created_at: string;
  media_type?: 'image' | 'video' | 'audio' | 'file';
  media_url?: string;
  media_thumbnail?: string | null;
  media_filename?: string | null;
  media_size?: number | null;
  media_duration?: number | null;
  url?: string;
  text?: string | null;
  encrypted?: boolean;
  // End-to-end encrypted items (from the decrypted message)
  media_key?: string;
  media_mime?: string;
  thumb_key?: string;
  media_v2?: { sha256: string; size: number }; // v2 files (PMV2)
  thumb_v2?: { sha256: string; size: number };
}

/** v2 items: the server only knows a file was shared; details and keys come from this browser's copy. */
async function fillV2Items(items: SharedItem[]): Promise<SharedItem[]> {
  const out: SharedItem[] = [];
  for (const item of items) {
    if (!isV2Marker(item.text)) {
      out.push(item);
      continue;
    }
    const local = await localFor(item.message_id).catch(() => null);
    if (!local || local.deleted) continue; // not on this device
    if (item.encrypted) { // a Links-tab item: list the links in our copy of the text
      const urls = Array.from(new Set((local.text || '').match(URL_RE) || [])).map((u) => u.replace(/[.,);!?]+$/, ''));
      urls.forEach((url) => out.push({ ...item, url, text: local.text }));
      continue;
    }
    const p = local.media?.[0];
    if (!p) continue;
    out.push({
      ...item, text: local.text, media_key: p.key, media_mime: p.mime, media_filename: p.name ?? null, media_size: p.size,
      media_duration: p.dur ?? null, media_v2: { sha256: p.sha256, size: p.size },
      ...(p.thumb ? { thumb_key: p.thumb.key, thumb_v2: { sha256: p.thumb.sha256, size: p.thumb.size } } : {}),
    });
  }
  return out;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Fill in what the server can't see for end-to-end encrypted items (names, keys, links). */
function decryptItems(conversationId: string, items: SharedItem[]): SharedItem[] {
  return items.flatMap((item) => {
    const opened = openText(item.text, conversationId, item.sender_id);
    if (!opened) return [item];
    if (!opened.ok) return item.encrypted ? [] : [item]; // links we can't read: leave them out
    if (item.encrypted) {
      const urls = Array.from(new Set(opened.text.match(URL_RE) || [])).map((u) => u.replace(/[.,);!?]+$/, ''));
      return urls.map((url) => ({ ...item, url, text: opened.text }));
    }
    const m = opened.media;
    return [m ? {
      ...item, text: opened.text, media_key: m.key, media_mime: m.mime, thumb_key: m.tk,
      media_filename: m.name ?? null, media_size: m.size ?? null, media_duration: m.d ?? null,
    } : item];
  });
}

export async function fetchShared(conversationId: string, kind: SharedKind, before?: string) {
  const { data } = await api.get(`/api/v1/conversations/${conversationId}/shared`, { params: { kind, before, limit: 60 } });
  return { items: await fillV2Items(decryptItems(conversationId, data.data as SharedItem[])), hasMore: !!data.has_more };
}

/** A photo or video thumbnail, decrypted first if it's end-to-end encrypted. */
const Thumb: React.FC<{ item: SharedItem; className: string }> = ({ item, className }) => {
  const video = item.media_type === 'video';
  const { src } = useMediaSrc(
    resolveMediaUrl(video ? item.media_thumbnail || undefined : item.media_url),
    video ? item.thumb_key : item.media_key,
    video ? 'image/jpeg' : item.media_mime,
    video ? item.thumb_v2 : item.media_v2,
  );
  return src ? <img src={src} alt="" loading="lazy" className={className} /> : <span className={`block ${className}`} />;
};

const SharedVoiceNote: React.FC<{ item: SharedItem }> = ({ item }) => {
  const { src, failed } = useMediaSrc(resolveMediaUrl(item.media_url), item.media_key, item.media_mime, item.media_v2);
  if (!src) return <p className="text-xs text-muted-500">{failed ? "Couldn't decrypt this voice message" : 'Decrypting…'}</p>;
  return <VoiceNotePlayer src={src} duration={item.media_duration || undefined} isSent={false} />;
};

const TABS: { kind: SharedKind; label: string }[] = [
  { kind: 'media', label: 'Media' },
  { kind: 'docs', label: 'Docs' },
  { kind: 'links', label: 'Links' },
];

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const SharedMedia: React.FC<{ conversationId: string; currentUserId?: string; onBack: () => void }> = ({ conversationId, currentUserId, onBack }) => {
  const [kind, setKind] = useState<SharedKind>('media');
  const [items, setItems] = useState<SharedItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<number | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set()); // files downloading (their buttons spin)

  const load = useCallback(async (more = false) => {
    setLoading(true);
    try {
      const before = more ? items[items.length - 1]?.created_at : undefined;
      const page = await fetchShared(conversationId, kind, before);
      setItems((current) => (more ? [...current, ...page.items] : page.items));
      setHasMore(page.hasMore);
    } catch (error) {
      toast.error(parseApiError(error));
    } finally {
      setLoading(false);
    }
  }, [conversationId, kind, items]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setItems([]); load(false); }, [conversationId, kind]);

  const media: ViewerImage[] = items
    .filter((i) => i.media_type === 'image' || i.media_type === 'video')
    .map((i) => ({
      id: i.message_id,
      url: resolveMediaUrl(i.media_url)!,
      mediaKey: i.media_key,
      mediaMime: i.media_mime,
      mediaV2: i.media_v2,
      filename: i.media_filename || undefined,
      senderName: i.sender_id === currentUserId ? 'You' : i.sender_name || undefined,
      timestamp: i.created_at,
      type: i.media_type as 'image' | 'video',
    }));

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-white">
      <div className="flex items-center gap-2 px-3 py-3 border-b border-muted-200">
        <button type="button" onClick={onBack} className="p-2 rounded-lg hover:bg-muted-100" aria-label="Back"><ArrowLeft className="w-5 h-5 text-muted-600" /></button>
        <h3 className="text-base font-semibold text-muted-900">Media, links and docs</h3>
      </div>
      <div className="flex border-b border-muted-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            aria-selected={kind === t.kind}
            onClick={() => setKind(t.kind)}
            className={`flex-1 py-2.5 text-sm font-medium border-b-2 ${kind === t.kind ? 'border-primary-700 text-primary-800' : 'border-transparent text-muted-500 hover:text-muted-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!loading && items.length === 0 && (
          <p className="px-6 py-12 text-center text-sm text-muted-500">
            {kind === 'media' ? 'No photos or videos yet' : kind === 'docs' ? 'No documents or voice messages yet' : 'No links yet'}
          </p>
        )}

        {kind === 'media' && (
          <div className="grid grid-cols-3 gap-0.5 p-0.5">
            {media.map((m, index) => {
              const item = items.find((i) => i.message_id === m.id)!;
              return (
                <button key={m.id} type="button" onClick={() => setViewer(index)} className="relative aspect-square bg-muted-100 overflow-hidden" aria-label={`Open ${m.type}`}>
                  <Thumb item={item} className="w-full h-full object-cover" />
                  {m.type === 'video' && (
                    <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 px-1 rounded bg-black/60 text-white text-[10px]">
                      <Play className="w-3 h-3" fill="currentColor" /> {formatDuration(item.media_duration)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {kind === 'docs' && (
          <ul className="divide-y divide-muted-100">
            {items.map((i) => (
              <li key={i.message_id} className="px-4 py-3">
                <p className="text-xs text-muted-500 mb-1">{i.sender_id === currentUserId ? 'You' : i.sender_name} · {dateLabel(i.created_at)}</p>
                {i.media_type === 'audio' ? (
                  <SharedVoiceNote item={i} />
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-lg bg-primary-50 text-primary-700 flex items-center justify-center"><FileText className="w-5 h-5" strokeWidth={1.75} /></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-muted-900 truncate">{i.media_filename || 'File'}</span>
                      <span className="block text-xs text-muted-500">{formatFileSize(i.media_size)}</span>
                    </span>
                    <button
                      type="button"
                      disabled={downloading.has(i.message_id)}
                      onClick={() => {
                        if (!i.media_key) {
                          downloadMedia(i.media_url!, i.media_filename || 'file').catch(() => toast.error("Couldn't download it"));
                          return;
                        }
                        setDownloading((d) => new Set(d).add(i.message_id));
                        downloadDecrypted(i.media_url!, i.media_key, i.media_mime, i.media_filename || 'file', i.media_v2) // shows its own progress
                          .finally(() => setDownloading((d) => { const next = new Set(d); next.delete(i.message_id); return next; }));
                      }}
                      className="p-2 rounded-lg text-primary-700 hover:bg-primary-50 disabled:hover:bg-transparent"
                      aria-label={`Download ${i.media_filename || 'file'}`}
                    >
                      {downloading.has(i.message_id) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {kind === 'links' && (
          <ul className="divide-y divide-muted-100">
            {items.map((i, n) => (
              <li key={`${i.message_id}-${n}`}>
                <a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-start gap-3 px-4 py-3 hover:bg-muted-50">
                  <span className="w-10 h-10 flex-shrink-0 rounded-lg bg-primary-50 text-primary-700 flex items-center justify-center"><Link2 className="w-5 h-5" strokeWidth={1.75} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-primary-800 truncate">{i.url}</span>
                    <span className="block text-xs text-muted-500 truncate">{i.sender_id === currentUserId ? 'You' : i.sender_name} · {dateLabel(i.created_at)}</span>
                  </span>
                  <ExternalLink className="w-4 h-4 mt-1 text-muted-400" />
                </a>
              </li>
            ))}
          </ul>
        )}

        {hasMore && !loading && (
          <div className="p-4 text-center">
            <button type="button" onClick={() => load(true)} className="px-4 py-1.5 text-sm rounded-full bg-primary-50 text-primary-700 hover:bg-primary-100">Load more</button>
          </div>
        )}
        {loading && <div className="py-8 flex justify-center"><span className="w-6 h-6 rounded-full border-2 border-primary-200 border-t-primary-700 animate-spin" /></div>}
      </div>

      {viewer !== null && media.length > 0 && (
        <MediaViewer images={media} index={Math.min(viewer, media.length - 1)} onIndexChange={setViewer} onClose={() => setViewer(null)} />
      )}
    </div>
  );
};

export default SharedMedia;

/** The row in chat info that opens the full view, with the latest few photos. */
export const SharedMediaRow: React.FC<{ conversationId: string; onOpen: () => void }> = ({ conversationId, onOpen }) => {
  const [preview, setPreview] = useState<SharedItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchShared(conversationId, 'media').then((page) => !cancelled && setPreview(page.items.slice(0, 4))).catch(() => undefined);
    return () => { cancelled = true; };
  }, [conversationId]);
  return (
    <button type="button" onClick={onOpen} className="w-full text-left px-6 py-4 border-b border-muted-100 hover:bg-muted-50">
      <span className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-500">Media, links and docs</span>
        <span className="text-xs text-primary-700">View all</span>
      </span>
      {preview.length > 0 && (
        <span className="mt-3 grid grid-cols-4 gap-1.5">
          {preview.map((i) => (
            <Thumb key={i.message_id} item={i} className="aspect-square w-full rounded-md object-cover bg-muted-100" />
          ))}
        </span>
      )}
    </button>
  );
};
