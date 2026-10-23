// src/utils/downloadToast.ts
// A download's progress as a toast: "Downloading report.pdf · 42%", then "Downloaded report.pdf"
// or why it failed. Used for files that download and decrypt in the page before they're saved.
import { toast } from 'react-toastify';

/** Run `work` with a progress toast. Never throws: a failure is shown in the toast. Resolves true when it worked. */
export async function withDownloadToast(name: string, work: (onProgress: (fraction: number) => void) => Promise<void>): Promise<boolean> {
  const label = name.length > 40 ? `${name.slice(0, 37)}…` : name;
  const id = toast.loading(`Downloading ${label}…`);
  let shown = -1;
  const onProgress = (fraction: number) => {
    const percent = Math.floor(fraction * 100);
    if (percent === shown) return;
    shown = percent;
    toast.update(id, { render: percent >= 100 ? `Decrypting ${label}…` : `Downloading ${label} · ${percent}%` });
  };
  try {
    await work(onProgress);
    toast.update(id, { render: `Downloaded ${label}`, type: 'success', isLoading: false, autoClose: 2500, closeButton: true });
    return true;
  } catch {
    toast.update(id, { render: `Couldn't download ${label}. Try again`, type: 'error', isLoading: false, autoClose: 5000, closeButton: true });
    return false;
  }
}

/** Plain files are saved by the browser itself (its own download bar): just say it started. */
export function downloadStarted(name: string): void {
  toast.info(`Downloading ${name.length > 40 ? `${name.slice(0, 37)}…` : name}`, { autoClose: 2500 });
}
