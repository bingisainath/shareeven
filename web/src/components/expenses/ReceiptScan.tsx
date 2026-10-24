// src/components/expenses/ReceiptScan.tsx
// Pick receipt photos -> upload -> the AI reads them in the background -> review.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Check, Images } from 'lucide-react';
import { toast } from 'react-toastify';
import { expenseService } from '../../services/expense.service';
import type { Expense, Receipt, ScanStep } from '../../services/expense.service';
import { mediaService } from '../../services/media.service';
import { parseApiError } from '../../utils/apiError';
import { RECEIPT_PROGRESS_EVENT, RECEIPT_READY_EVENT } from '../../utils/events';
import { mediaTypeOf, resolveMediaUrl, validateFile } from '../../utils/media';
import ReceiptReview from './ReceiptReview';
import type { Member } from './shared';

const MAX_PHOTOS = 4;

interface Props {
  conversationId: string;
  members: Member[];
  currentUserId: string;
  receiptId?: string; // continue reviewing one
  onSaved: (expense: Expense) => void;
  onManual: () => void;
  onClose: () => void;
}

const ReceiptScan: React.FC<Props> = ({ conversationId, members, currentUserId, receiptId, onSaved, onManual, onClose }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'reading'>(receiptId ? 'reading' : 'idle');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [drafts, setDrafts] = useState<Awaited<ReturnType<typeof expenseService.openReceipts>>>([]);
  const [steps, setSteps] = useState<ScanStep[]>([]); // what the AI has done so far, the last one in progress
  const [seconds, setSeconds] = useState(0);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const currentId = useRef<string | undefined>(receiptId);

  const addStep = useCallback((next: ScanStep) => {
    setSteps((current) => (current.some((s) => s.step === next.step) ? current : [...current, next]));
  }, []);

  useEffect(() => {
    if (receiptId) return;
    expenseService.openReceipts(conversationId).then(setDrafts).catch(() => undefined);
  }, [conversationId, receiptId]);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const load = useCallback(async (id: string) => {
    const r = await expenseService.getReceipt(id);
    if (currentId.current !== id) return;
    if (r.status === 'processing') {
      if (r.progress) addStep(r.progress);
      return;
    }
    setReceipt(r);
    setBusy('idle');
  }, [addStep]);

  // Done when the server says so (WebSocket), with a slow poll as a safety net
  useEffect(() => {
    if (busy !== 'reading' || !currentId.current) return;
    const id = currentId.current;
    (window as any).__waitingForReceiptId = id;
    load(id).catch(() => undefined);
    const onReady = (e: Event) => {
      if ((e as CustomEvent).detail?.receiptId === id) load(id).catch(() => undefined);
    };
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.receiptId === id && detail.step && detail.label) addStep({ step: detail.step, label: detail.label });
    };
    window.addEventListener(RECEIPT_READY_EVENT, onReady);
    window.addEventListener(RECEIPT_PROGRESS_EVENT, onProgress);
    const poll = setInterval(() => load(id).catch(() => undefined), 5000);
    const started = Date.now();
    setSeconds(0);
    const tick = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => {
      window.removeEventListener(RECEIPT_READY_EVENT, onReady);
      window.removeEventListener(RECEIPT_PROGRESS_EVENT, onProgress);
      clearInterval(poll);
      clearInterval(tick);
      if ((window as any).__waitingForReceiptId === id) (window as any).__waitingForReceiptId = null;
    };
  }, [busy, load, addStep]);

  const pick = (list: FileList | null) => {
    if (!list) return;
    const chosen = Array.from(list).filter((f) => {
      const error = validateFile(f) || (mediaTypeOf(f) !== 'image' ? 'Choose a photo of the receipt' : null);
      if (error) toast.error(`${f.name}: ${error}`);
      return !error;
    });
    setFiles((current) => [...current, ...chosen].slice(0, MAX_PHOTOS));
  };

  const start = async () => {
    if (!files.length) return;
    setBusy('uploading');
    try {
      const uploaded = await Promise.all(files.map((f) => mediaService.upload(f)));
      const created = await expenseService.scanReceipt(conversationId, uploaded.map((u) => u.url), note.trim());
      currentId.current = created.id;
      setSteps([]);
      setBusy('reading');
    } catch (error) {
      toast.error(parseApiError(error));
      setBusy('idle');
    }
  };

  const retry = async () => {
    if (!receipt) return;
    try {
      await expenseService.retryReceipt(receipt.id);
      currentId.current = receipt.id;
      setReceipt(null);
      setSteps([]);
      setBusy('reading');
    } catch (error) {
      toast.error(parseApiError(error));
    }
  };

  if (busy === 'reading') {
    return (
      <div className="py-16 text-center">
        <div className="mx-auto mb-4 w-12 h-12 rounded-full border-4 border-primary-200 border-t-primary-600 animate-spin" />
        <p className="font-medium text-muted-900">Reading the receipt…</p>
        <p className="text-sm text-muted-500 mt-1">{seconds > 0 && `${seconds}s · `}This usually takes 10–40 seconds. You can close this; we’ll let you know when it’s ready.</p>
        {steps.length > 0 && (
          <ol className="mt-5 mx-auto max-w-xs space-y-2 text-left" aria-live="polite">
            {steps.map((s, i) => {
              const done = i < steps.length - 1;
              return (
                <li key={s.step} className="flex items-center gap-2 text-sm">
                  {done
                    ? <Check className="w-4 h-4 flex-shrink-0 text-success-600" aria-label="Done" />
                    : <span className="w-4 h-4 flex-shrink-0 rounded-full border-2 border-primary-200 border-t-primary-600 animate-spin" aria-hidden />}
                  <span className={done ? 'text-muted-500' : 'font-medium text-muted-900'}>{s.label}</span>
                </li>
              );
            })}
          </ol>
        )}
        <button type="button" onClick={onClose} className="mt-6 text-sm text-primary-700 hover:underline">Close and wait in the background</button>
      </div>
    );
  }

  if (receipt && receipt.status === 'failed') {
    // A new photo fixes most failed reads (blurry, dark, cut off); the failed scan doesn't count
    const newPhoto = () => {
      if (receipt.uploaded_by === currentUserId) expenseService.discardReceipt(receipt.id).catch(() => undefined);
      currentId.current = undefined;
      setReceipt(null);
      setFiles([]);
      setSteps([]);
      setBusy('idle');
    };
    return (
      <div className="py-10 text-center space-y-4">
        <p className="font-medium text-muted-900">Couldn’t read this receipt</p>
        <p className="text-sm text-accent-600 max-w-sm mx-auto">{receipt.error}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" onClick={newPhoto} className="px-4 py-2 rounded-lg bg-primary-600 text-white font-medium">Take a new photo</button>
          {receipt.uploaded_by === currentUserId && (
            <button type="button" onClick={retry} className="px-4 py-2 rounded-lg bg-primary-50 text-primary-700 font-medium">Try the same photo again</button>
          )}
          <button type="button" onClick={onManual} className="px-4 py-2 rounded-lg bg-muted-100 font-medium">Enter it manually</button>
        </div>
      </div>
    );
  }

  if (receipt) {
    return (
      <ReceiptReview
        receipt={receipt}
        members={members}
        currentUserId={currentUserId}
        onSaved={onSaved}
        onDiscard={onClose}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {previews.map((src, i) => (
          <div key={src} className="relative aspect-[3/4] rounded-xl overflow-hidden bg-muted-100">
            <img src={src} alt={`Receipt part ${i + 1}`} className="w-full h-full object-cover" />
            <button
              type="button"
              aria-label="Remove photo"
              onClick={() => setFiles((f) => f.filter((_, n) => n !== i))}
              className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white text-sm"
            >
              ×
            </button>
          </div>
        ))}
        {files.length < MAX_PHOTOS && (
          <div className="aspect-[3/4] rounded-xl border-2 border-dashed border-muted-300 flex flex-col overflow-hidden text-muted-500">
            <span className="pt-2 text-center text-xs">{files.length ? 'Add another part' : 'Photo of the bill'}</span>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="flex-1 flex flex-col items-center justify-center gap-1 hover:bg-primary-50"
            >
              <Camera className="w-7 h-7 text-primary-600" strokeWidth={1.5} aria-hidden />
              <span className="text-sm">Take photo</span>
            </button>
            <div className="mx-3 border-t border-muted-200" />
            <button
              type="button"
              onClick={() => galleryRef.current?.click()}
              className="flex-1 flex flex-col items-center justify-center gap-1 hover:bg-primary-50"
            >
              <Images className="w-7 h-7 text-primary-600" strokeWidth={1.5} aria-hidden />
              <span className="text-sm">Gallery</span>
            </button>
          </div>
        )}
      </div>
      {/* capture opens the phone's camera straight away; the second input lets you pick saved photos */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => { pick(e.target.files); e.target.value = ''; }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => { pick(e.target.files); e.target.value = ''; }}
      />
      <div className="rounded-xl border border-primary-100 bg-primary-50/60 px-3.5 py-3 text-xs text-muted-700">
        <p className="font-semibold text-primary-800">Take a clear photo</p>
        <ul className="mt-1.5 space-y-1 list-disc pl-4">
          <li>Sharp, not blurry: hold still and let the camera focus</li>
          <li>Good light, no shadow or glare across the text</li>
          <li>The receipt flat, the whole width in the frame</li>
          <li>Long receipt? Up to {MAX_PHOTOS} photos, top to bottom</li>
        </ul>
        <p className="mt-1.5 text-muted-500">If a photo is too blurry to read, we’ll ask you for a new one.</p>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        placeholder="Note for the scan (optional), e.g. “ignore the bag charge”"
        className="w-full px-3 py-2 rounded-lg border border-muted-300 text-sm"
      />
      <button
        type="button"
        onClick={start}
        disabled={!files.length || busy !== 'idle'}
        className="w-full py-3 rounded-xl bg-primary-600 hover:bg-primary-700 text-white font-semibold disabled:opacity-50"
      >
        {busy === 'uploading' ? 'Uploading…' : 'Read receipt'}
      </button>

      {drafts.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-700">Not finished yet</p>
          {drafts.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => { currentId.current = d.id; setBusy('reading'); }}
              className="w-full flex items-center gap-3 p-2 rounded-xl border border-muted-200 hover:bg-muted-50 text-left"
            >
              {d.images[0] && <img src={resolveMediaUrl(d.images[0])} alt="" className="w-10 h-12 rounded object-cover" />}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate">{d.store_name || 'Receipt'}</span>
                <span className="block text-xs text-muted-500">
                  {d.status === 'processing' ? 'Still reading…' : d.status === 'failed' ? 'Couldn’t read it' : 'Ready to review'} · {new Date(d.created_at).toLocaleString()}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReceiptScan;
