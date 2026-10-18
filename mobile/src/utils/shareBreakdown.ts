// src/utils/shareBreakdown.ts
// What one person's share of a receipt expense is made of, as lines to show on the expense details.
// Same as web/src/utils/shareBreakdown.ts.

import type { Receipt } from '../api/expenses';
import { formatMinor } from './money';

export interface ShareLine {
  key: string;
  label: string; // "2 × Barilla Fusilli 500g", "Tip", "Rounding"
  detail: string | null; // "split 3 ways · €3.40 − €1.90 off"
  amount: number; // this person's part, in minor units
}

/**
 * The lines behind `userId`'s share, or null when the receipt no longer explains it (the expense was
 * edited by hand afterwards, so its share differs from what the receipt adds up to).
 */
export function shareLines(receipt: Receipt, userId: string, shareMinor: number): ShareLine[] | null {
  const person = receipt.totals?.people.find((p) => p.user_id === userId);
  if (!person || person.amount_minor !== shareMinor) return null;
  const currency = receipt.currency || 'EUR';
  return person.breakdown
    .filter((part) => part.amount !== 0)
    .map((part, n) => {
      if (part.type === 'item' && part.id !== null && receipt.items[part.id]) {
        const item = receipt.items[part.id];
        const quantity = Number(item.quantity);
        const label = item.unit === 'each' && quantity > 1 ? `${item.quantity} × ${item.name}` : item.name;
        const details: string[] = [];
        if (item.assignments.length > 1) details.push(`split ${item.assignments.length} ways`);
        if (item.net_minor !== null && item.net_minor < item.gross_minor) {
          details.push(`${formatMinor(item.gross_minor, currency)} − ${formatMinor(item.gross_minor - item.net_minor, currency)} off`);
        }
        return { key: `i${part.id}`, label, detail: details.join(' · ') || null, amount: part.amount };
      }
      if (part.type === 'adjustment' && part.id !== null && receipt.adjustments[part.id]) {
        return { key: `a${part.id}`, label: receipt.adjustments[part.id].label, detail: null, amount: part.amount };
      }
      return { key: `r${n}`, label: 'Rounding', detail: 'to the cent, so shares add up to the total', amount: part.amount };
    });
}
