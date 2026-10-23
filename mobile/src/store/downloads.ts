// src/store/downloads.ts
// Files being downloaded and saved to the phone, and how far each has got: the file's bubble,
// its Save button and the bar at the bottom of the screen show it (DownloadsBar).
import { create } from 'zustand';

export interface ActiveDownload {
  key: string; // the file's address without its signature
  name: string;
  progress?: number; // 0 to 1, when known
}

interface DownloadsState {
  active: ActiveDownload[];
  start: (key: string, name: string) => void;
  progress: (key: string, fraction: number) => void;
  finish: (key: string) => void;
}

export const downloadKey = (url: string) => url.split('?')[0];

export const useDownloads = create<DownloadsState>((set) => ({
  active: [],
  start: (key, name) => set((s) => ({ active: [...s.active.filter((d) => d.key !== key), { key, name }] })),
  progress: (key, fraction) => set((s) => ({
    active: s.active.map((d) => (d.key === key && Math.floor((d.progress ?? -1) * 100) !== Math.floor(fraction * 100) ? { ...d, progress: fraction } : d)),
  })),
  finish: (key) => set((s) => ({ active: s.active.filter((d) => d.key !== key) })),
}));

/** This file's download, while it's under way. */
export const useDownloadOf = (url?: string | null) =>
  useDownloads((s) => (url ? s.active.find((d) => d.key === downloadKey(url)) : undefined));

/** "Downloading 42%", or without a size yet just "Downloading…". */
export const downloadLabel = (d: ActiveDownload) =>
  d.progress === undefined ? 'Downloading…' : d.progress >= 1 ? 'Saving…' : `Downloading ${Math.floor(d.progress * 100)}%`;
