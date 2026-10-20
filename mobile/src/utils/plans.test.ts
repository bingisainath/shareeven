import { DEFAULT_PRO, formatPrice, perMonth, planCurrency, providersFor, yearlySaving, CARD_PROVIDER_READY } from './plans';
import type { ProPlan } from './plans';

const only = (prices: ProPlan['prices'], providers?: Partial<ProPlan['providers']>): ProPlan =>
  ({ ...DEFAULT_PRO, prices, providers: { ...DEFAULT_PRO.providers, ...providers } });

describe('plans', () => {
  it('charges in the display currency when Pro has a price in it', () => {
    expect(planCurrency(DEFAULT_PRO, 'usd', 'en-US')).toBe('USD');
    expect(planCurrency(DEFAULT_PRO, 'INR')).toBe('INR');
  });

  it('falls back to rupees in India and euros elsewhere', () => {
    expect(planCurrency(DEFAULT_PRO, 'JPY', 'en-IN')).toBe('INR');
    expect(planCurrency(DEFAULT_PRO, null, 'hi_IN')).toBe('INR');
    expect(planCurrency(DEFAULT_PRO, undefined, 'de-DE')).toBe('EUR');
    expect(planCurrency(DEFAULT_PRO, undefined, '')).toBe('EUR');
  });

  it('uses a currency admins priced when the usual one has no price', () => {
    expect(planCurrency(only({ USD: { monthly: 300, yearly: 3000 } }), undefined, 'en-IN')).toBe('USD');
    // Rupees and dollars only: India pays in rupees, everyone else in dollars (never rupees)
    const inrUsd = only({ INR: { monthly: 9900, yearly: 99900 }, USD: { monthly: 299, yearly: 2999 } });
    expect(planCurrency(inrUsd, undefined, 'en-IN')).toBe('INR');
    expect(planCurrency(inrUsd, 'EUR', 'de-DE')).toBe('USD');
    expect(planCurrency(inrUsd, undefined, 'en-GB')).toBe('USD');
    expect(planCurrency(only({ INR: { monthly: 9900, yearly: 99900 } }), undefined, 'en-US')).toBe('INR'); // the only price there is
  });

  it('offers the providers admins turned on, Razorpay only in its currencies', () => {
    expect(providersFor(DEFAULT_PRO, 'INR').map((p) => p.id)).toEqual(['razorpay']);
    expect(providersFor(only(DEFAULT_PRO.prices, { razorpay_currencies: ['INR', 'USD'] }), 'USD').map((p) => p.id)).toEqual(['razorpay']);
    expect(providersFor(only(DEFAULT_PRO.prices, { razorpay: false }), 'INR')).toEqual([]);
  });

  it("never offers the card provider while it isn't built, even when admins turn it on", () => {
    expect(CARD_PROVIDER_READY).toBe(false);
    expect(DEFAULT_PRO.providers.card).toBe(true);
    expect(providersFor(DEFAULT_PRO, 'EUR')).toEqual([]); // the Plan page then says "Can't pay in EUR yet"
  });

  it('every default price is whole minor units and a year costs less than twelve months', () => {
    for (const [currency, p] of Object.entries(DEFAULT_PRO.prices)) {
      expect(Number.isInteger(p.monthly) && Number.isInteger(p.yearly)).toBe(true);
      expect(yearlySaving(DEFAULT_PRO, currency)).toBeGreaterThan(0);
    }
    expect(yearlySaving(DEFAULT_PRO, 'XXX')).toBe(0);
  });

  it('formats prices without ".00" on whole amounts', () => {
    expect(formatPrice(99900, 'INR')).toMatch(/999(?![.,]\d)/);
    expect(formatPrice(2999, 'EUR')).toMatch(/29[.,]99/);
    expect(formatPrice(0, 'EUR')).toMatch(/0(?![.,]\d)/);
  });

  it('shows a whole-unit yearly price per month in whole units', () => {
    expect(perMonth(149900)).toBe(12500); // ₹1,499 a year -> ₹125 a month
    expect(perMonth(2999)).toBe(250); // €29.99 -> €2.50
  });
});
