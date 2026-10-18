// src/components/expenses/ReceiptLine.tsx
// One printed line of a receipt photo, cut out and turned upright, so an item can be checked at a glance.

import React, { useEffect, useRef, useState } from 'react';
import type { SourceBox } from '../../services/expense.service';

const ReceiptLine: React.FC<{ src: string; box: SourceBox; className?: string }> = ({ src, box, className }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvas.current;
      if (!c) return;
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const [x0, y0, x1, y1] = box.box;
      // A margin of about half a line around it, so the neighbouring lines give context
      const thickness = Math.min((x1 - x0) * W, (y1 - y0) * H);
      const pad = thickness * 0.6;
      const sx = Math.max(0, x0 * W - pad);
      const sy = Math.max(0, y0 * H - pad);
      const sw = Math.min(W, x1 * W + pad) - sx;
      const sh = Math.min(H, y1 * H + pad) - sy;
      const sideways = Math.abs(box.turned) === 90;
      // Draw at the photo's own resolution (at most 1000px wide) and let CSS scale it down
      const k = Math.min(1, 1000 / (sideways ? sh : sw));
      c.width = Math.round((sideways ? sh : sw) * k);
      c.height = Math.round((sideways ? sw : sh) * k);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (box.turned === 90) { // the text runs bottom to top: turn it anticlockwise
        ctx.translate(0, c.height);
        ctx.rotate(-Math.PI / 2);
      } else if (box.turned === -90) {
        ctx.translate(c.width, 0);
        ctx.rotate(Math.PI / 2);
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw * k, sh * k);
    };
    img.onerror = () => setFailed(true);
    img.src = src;
  }, [src, box]);

  if (failed) return null;
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label="This line on the receipt"
      className={`block w-full h-auto max-h-28 object-contain rounded-lg border border-muted-200 bg-white ${className || ''}`}
    />
  );
};

export default ReceiptLine;
