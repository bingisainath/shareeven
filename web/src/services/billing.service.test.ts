import { AxiosError, AxiosHeaders } from 'axios';
import api from '../utils/axios';
import { startCheckout } from './billing.service';

jest.mock('../utils/axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const post = api.post as jest.Mock;

const order = { key_id: 'rzp_test_x', order_id: 'order_1', amount: 9900, currency: 'INR', name: 'ShareEven', description: 'Pro', prefill: {} };
const success = { razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' };
const request = { billing: 'monthly' as const, currency: 'INR', provider: 'razorpay' as const };

/** A fake checkout.js: `act` decides what the person does once it opens. */
function fakeRazorpay(act: (o: any, failed: (description: string) => void) => void) {
  const opened: any[] = [];
  (window as any).Razorpay = function (options: any) {
    let onFailed = (_: any) => {};
    opened.push(options);
    return {
      on: (_event: string, handler: any) => { onFailed = handler; },
      open: () => act(options, (description) => onFailed({ error: { description } })),
    };
  };
  return opened;
}

const httpError = (status: number, detail: string) =>
  new AxiosError('fail', String(status), undefined, undefined,
    { status, data: { detail }, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });

beforeEach(() => post.mockReset());

it('opens the checkout with the server order and confirms the payment', async () => {
  const opened = fakeRazorpay((o) => o.handler(success));
  post.mockResolvedValueOnce({ data: { data: order } })
    .mockResolvedValueOnce({ data: { data: { payment: 'paid', current: { plan: 'pro', until: '2026-11-20T00:00:00Z' } } } });

  await expect(startCheckout(request)).resolves.toEqual({ status: 'paid', current: { plan: 'pro', until: '2026-11-20T00:00:00Z' } });
  expect(post).toHaveBeenNthCalledWith(1, '/api/v1/billing/checkout', { billing: 'monthly', currency: 'INR' }); // no price from the app
  expect(opened[0]).toMatchObject({ key: 'rzp_test_x', order_id: 'order_1', amount: 9900, currency: 'INR' });
  expect(post).toHaveBeenNthCalledWith(2, '/api/v1/billing/verify', success);
});

it('closing the checkout is a cancel; closing it after a failed try says why', async () => {
  fakeRazorpay((o) => o.modal.ondismiss());
  post.mockResolvedValue({ data: { data: order } });
  await expect(startCheckout(request)).resolves.toEqual({ status: 'cancelled' });

  fakeRazorpay((o, failed) => { failed('Card declined'); o.modal.ondismiss(); });
  await expect(startCheckout(request)).resolves.toEqual({ status: 'failed', message: "The payment didn't go through: Card declined" });
  expect(post).not.toHaveBeenCalledWith('/api/v1/billing/verify', expect.anything());
});

it("shows the server's reason when checkout is refused", async () => {
  post.mockRejectedValueOnce(httpError(400, "Payments in EUR aren't available yet"));
  await expect(startCheckout({ ...request, currency: 'EUR' })).resolves.toEqual({ status: 'failed', message: "Payments in EUR aren't available yet" });
});

it("is pending when the payment can't be confirmed yet", async () => {
  fakeRazorpay((o) => o.handler(success));
  post.mockResolvedValueOnce({ data: { data: order } }).mockRejectedValueOnce(httpError(502, 'We got your payment but couldn\'t confirm it yet'));
  await expect(startCheckout(request)).resolves.toMatchObject({ status: 'pending' });
});

it("doesn't offer the card provider yet", async () => {
  await expect(startCheckout({ ...request, provider: 'card' })).resolves.toMatchObject({ status: 'unavailable' });
  expect(post).not.toHaveBeenCalled();
});
