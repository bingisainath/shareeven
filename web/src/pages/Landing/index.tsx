// src/pages/Landing/index.tsx
// The public homepage (shareeven.com/) for people who aren't signed in, from the Figma design
// (styles in ./landing.css, all scoped under .se-landing). Signed-in people go straight to /chat.

import React, { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../app/AuthProvider';
import { loadPublicPlan } from '../../services/billing.service';
import { formatPrice, perMonth, planCurrency } from '../../utils/plans';
import type { ProPlan } from '../../utils/plans';
import './landing.css';

type IconName = 'arrow' | 'check' | 'chevron' | 'coins' | 'globe' | 'lock' | 'message' | 'receipt' | 'scan' | 'send' | 'shield' | 'sparkles' | 'split' | 'users' | 'wallet' | 'x';

const iconPaths: Record<IconName, ReactNode> = {
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  coins: (
    <>
      <ellipse cx="9" cy="6" rx="6" ry="3" />
      <path d="M3 6v4c0 1.7 2.7 3 6 3s6-1.3 6-3V6M3 10v4c0 1.7 2.7 3 6 3 1.1 0 2-.1 2.8-.4" />
      <path d="M15 11c3.3 0 6 1.3 6 3s-2.7 3-6 3-6-1.3-6-3M9 14v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2.5" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10M12 14v3" />
    </>
  ),
  message: (
    <>
      <path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4Z" />
      <path d="M8 9h7M8 13h4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 2h12v20l-3-2-3 2-3-2-3 2Z" />
      <path d="M9 7h6M9 11h6M9 15h3" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3-1.4 4.6L6 9l4.6 1.4L12 15l1.4-4.6L18 9l-4.6-1.4ZM5 15l-.7 2.3L2 18l2.3.7L5 21l.7-2.3L8 18l-2.3-.7Z" />
      <path d="m19 15-.5 1.5L17 17l1.5.5L19 19l.5-1.5L21 17l-1.5-.5Z" />
    </>
  ),
  split: (
    <>
      <path d="M4 6h4a4 4 0 0 1 4 4v8M12 14v4M12 10a4 4 0 0 1 4-4h4" />
      <path d="m17 3 3 3-3 3M9 15l3 3-3 3" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 6h15a2 2 0 0 1 2 2v11H5a2 2 0 0 1-2-2V6Z" />
      <path d="M3 8V5a2 2 0 0 1 2-2h12v3M16 12h5" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
};

const Icon: React.FC<{ name: IconName; size?: number }> = ({ name, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {iconPaths[name]}
  </svg>
);

const Logo: React.FC = () => (
  <Link className="logo" to="/" aria-label="ShareEven home">
    <span className="logo-mark">S</span>
    <span>ShareEven</span>
  </Link>
);

const ArrowLink: React.FC<{ to: string; className?: string; children: ReactNode }> = ({ to, className = '', children }) => (
  <Link className={`arrow-link ${className}`} to={to}>
    {children}
    <Icon name="arrow" size={17} />
  </Link>
);

const SectionHeading: React.FC<{ eyebrow: string; title: string; body?: string }> = ({ eyebrow, title, body }) => (
  <div className="section-heading">
    <span className="eyebrow">{eyebrow}</span>
    <h2>{title}</h2>
    {body && <p>{body}</p>}
  </div>
);

const features: { icon: IconName; title: string; body: string }[] = [
  { icon: 'shield', title: 'Private by design', body: 'End-to-end encryption keeps every conversation between the people in it.' },
  { icon: 'split', title: 'Split any way', body: 'Equal, exact amounts, shares or percentages, or item by item from a receipt.' },
  { icon: 'scan', title: 'Scan the receipt', body: 'AI reads items, taxes and discounts, so everyone can claim what was theirs.' },
  { icon: 'globe', title: 'Any currency', body: 'Plan in euro, pay in rupees, settle in pounds. ShareEven keeps it all clear.' },
  { icon: 'wallet', title: 'Settle up in a tap', body: 'Open UPI, Revolut or PayPal directly. ShareEven never holds your money.' },
  { icon: 'message', title: 'Chat and money together', body: 'Expenses live where the plans happen, so nobody has to chase another app.' },
];

const steps: { icon: IconName; title: string; body: string }[] = [
  { icon: 'users', title: 'Start a chat or group', body: 'Bring in your flatmates, travel crew or just the two of you.' },
  { icon: 'receipt', title: 'Add it as it happens', body: 'Enter an expense in seconds, or scan the whole receipt.' },
  { icon: 'coins', title: 'Settle up simply', body: 'We work out the fewest payments and open your payment app.' },
];

const faqs = [
  { q: 'Can ShareEven read my messages?', a: "No. Messages are encrypted on your device before they're sent, so only the people in the conversation can read them, not even ShareEven." },
  { q: 'Does ShareEven move money?', a: 'No. ShareEven works out who owes what, then opens services like Revolut, PayPal or UPI so you can pay each other directly.' },
  { q: 'Is it free?', a: 'Yes. Chats, groups and expenses are free, along with a monthly allowance of AI receipt scans.' },
];

/** A group conversation in a phone, drawn in HTML (not a screenshot). */
const PhoneMockup: React.FC = () => (
  <div className="phone-wrap" aria-label="Preview of a ShareEven group conversation">
    <div className="float-card float-settled">
      <span className="float-icon success"><Icon name="check" size={15} /></span>
      <span><small>Tom paid you</small><strong>Settled up</strong></span>
      <b>€60</b>
    </div>
    <div className="float-card float-payments">
      <span className="payment-dots"><i>R</i><i>P</i><i>U</i></span>
      <span><strong>Pay your way</strong><small>UPI · Revolut · PayPal</small></span>
    </div>
    <div className="phone">
      <div className="phone-top"><span>9:41</span><i /><span className="phone-status">● ◒</span></div>
      <div className="chat-head">
        <span className="back">‹</span>
        <div className="group-avatar"><span>R</span><span>A</span></div>
        <div><strong>Weekend in Galway</strong><small><i /> 4 members</small></div>
        <span className="phone-more">•••</span>
      </div>
      <div className="encryption-note"><Icon name="lock" size={10} />Messages are end-to-end encrypted</div>
      <div className="phone-chat">
        <span className="chat-day">TODAY</span>
        <div className="phone-bubble bubble-left"><b>Aisha</b>Who paid for the B&amp;B?<time>10:42</time></div>
        <div className="phone-bubble bubble-right">Me! Adding it now<time>10:43 ✓✓</time></div>
        <div className="expense-card">
          <div className="expense-title">
            <span><Icon name="receipt" size={17} /></span>
            <div><small>ACCOMMODATION</small><strong>B&amp;B, 2 nights</strong></div>
            <b>€240</b>
          </div>
          <div className="expense-meta"><span>Split 4 ways</span><span>€60 each</span></div>
          <div className="progress"><i /></div>
          <div className="owed"><span>You’re owed</span><strong>€180</strong></div>
        </div>
        <div className="receipt-card">
          <span className="receipt-spark"><Icon name="sparkles" size={16} /></span>
          <div><strong>Receipt read</strong><small>14 items · total matches</small></div>
          <span className="check-circle"><Icon name="check" size={13} /></span>
        </div>
      </div>
      <div className="phone-input">
        <span>+</span>
        <div>Message</div>
        <span className="mini-send"><Icon name="send" size={14} /></span>
      </div>
      <div className="home-line" />
    </div>
  </div>
);

const PrivacyVisual: React.FC = () => (
  <div className="privacy-visual">
    <div className="privacy-top">
      <span><Icon name="lock" size={18} /></span>
      <div><small>END-TO-END ENCRYPTED</small><strong>Only your group has the keys</strong></div>
    </div>
    <div className="privacy-message">
      <span className="privacy-avatar">A</span>
      <div><small>AISHA</small><p>I’ve added the train tickets, it’s €24 each.</p></div>
    </div>
    <div className="encryption-path"><span /><i><Icon name="lock" size={14} /></i><span /></div>
    <div className="server-card">
      <span><Icon name="shield" size={22} /></span>
      <div><small>WHAT THE SERVER SEES</small><strong>x7Gq…9fKw</strong></div>
      <i>Unreadable</i>
    </div>
  </div>
);

const PricingCard: React.FC<{ plus?: boolean; soon?: boolean; title: string; price: string; per?: string; note?: string; children: ReactNode; action: ReactNode }> = ({ plus, soon, title, price, per, note, children, action }) => (
  <article className={`pricing-card ${plus ? 'pricing-plus' : ''}`}>
    {soon && <span className="coming-badge">COMING SOON</span>}
    <div className="price-head">
      <h3>{title}</h3>
      <p>{plus ? 'For groups that scan and share more.' : 'Everything you need to share fairly.'}</p>
    </div>
    <div className="price">
      <strong>{price}</strong>
      {per && <span>{per}</span>}
    </div>
    {note && <p className="price-note">{note}</p>}
    <ul>{children}</ul>
    {action}
  </article>
);

const Check: React.FC<{ children: ReactNode }> = ({ children }) => <li><Icon name="check" size={15} /> {children}</li>;

const Landing: React.FC = () => {
  const { user, isLoading } = useAuth();
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  // Pro's real prices (set in Admin → Pro & payments); null until loaded, so no made-up price ever shows
  const [pro, setPro] = useState<ProPlan | null>(null);
  useEffect(() => { loadPublicPlan().then(setPro).catch(() => setPro(null)); }, []);
  const currency = pro ? planCurrency(pro, user?.display_currency, typeof navigator !== 'undefined' ? navigator.language : '') : 'INR';
  const proPrice = pro?.prices[currency];

  useEffect(() => {
    document.title = 'ShareEven: chat privately, split fairly';
    return () => { document.title = 'ShareEven'; };
  }, []);

  if (isLoading) return <div className="min-h-screen bg-white" />;
  if (user) return <Navigate to="/chat" replace />;

  return (
    <div className="se-landing">
      <main id="top">
        <header className="site-header">
          <div className="nav-shell">
            <Logo />
            <nav aria-label="Main navigation">
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#privacy">Privacy</a>
              <a href="#pricing">Pricing</a>
              <a href="#faq">FAQ</a>
            </nav>
            <div className="nav-actions">
              <Link className="login-link" to="/login">Log in</Link>
              <Link className="nav-cta" to="/signup">
                <span className="desktop-cta">Get started</span>
                <span className="mobile-cta">Start free</span>
                <Icon name="arrow" size={16} />
              </Link>
            </div>
          </div>
        </header>

        <section className="hero">
          <div className="hero-orb orb-one" />
          <div className="hero-orb orb-two" />
          <div className="page-shell hero-grid">
            <div className="hero-copy">
              <span className="hero-pill"><Icon name="shield" size={15} />End-to-end encrypted</span>
              <h1>Chat privately.<br />Split fairly.</h1>
              <p>
                One app for your conversations and your shared money. Talk with your flat, your trip or your partner,
                add expenses as they happen, and settle up without the awkward maths.
              </p>
              <div className="hero-actions">
                <Link className="hero-primary" to="/signup">Create a free account<Icon name="arrow" size={18} /></Link>
                <Link className="hero-secondary" to="/login">Log in</Link>
              </div>
              <div className="availability">
                <span className="availability-icons"><i /><i /></span>
                Works in your browser and on Android.<br className="mobile-break" /> iPhone app coming later.
              </div>
            </div>
            <PhoneMockup />
          </div>
        </section>

        <section className="section features-section" id="features">
          <div className="page-shell">
            <SectionHeading eyebrow="Everything in one place" title="Plans, payments and people, together."
              body="The simplicity of your group chat, with shared expenses built right in." />
            <div className="feature-grid">
              {features.map((feature) => (
                <article className="feature-card" key={feature.title}>
                  <span className="feature-icon"><Icon name={feature.icon} size={23} /></span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section how-section" id="how">
          <div className="page-shell">
            <SectionHeading eyebrow="How it works" title="From “shall we?” to settled."
              body="No spreadsheets. No separate money chat. Just three simple steps." />
            <div className="steps-grid">
              {steps.map((step, index) => (
                <article className="step-card" key={step.title}>
                  <div className="step-illustration">
                    <span className="step-number">0{index + 1}</span>
                    <span className="step-main-icon"><Icon name={step.icon} size={31} /></span>
                    {index === 0 && <span className="mini-people"><i>A</i><i>R</i><i>T</i></span>}
                    {index === 1 && <span className="scan-line" />}
                    {index === 2 && <span className="mini-paid">Paid ✓</span>}
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  {index < steps.length - 1 && <span className="step-arrow"><Icon name="arrow" size={20} /></span>}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section privacy-section" id="privacy">
          <div className="page-shell privacy-grid">
            <div className="privacy-copy">
              <span className="eyebrow">Privacy, not a promise: a design</span>
              <h2>We can’t read your chats. That’s the point.</h2>
              <p>Your conversations are yours. Strong encryption protects every message before it leaves your device.</p>
              <ul>
                <Check>Encrypted on your device</Check>
                <Check>No ads, profiling or tracking</Check>
                <Check>Download or delete your data any time</Check>
                <Check>Simple tools to block and report</Check>
              </ul>
              <ArrowLink to="/privacy" className="privacy-link">How we protect your privacy</ArrowLink>
            </div>
            <PrivacyVisual />
          </div>
        </section>

        <section className="section pricing-section" id="pricing">
          <div className="page-shell">
            <SectionHeading eyebrow="Simple pricing" title="Start sharing. Stay for free."
              body="No card required. No limit on the people or plans that matter." />
            <div className="pricing-grid">
              <PricingCard title="Free" price={formatPrice(0, currency)} per="forever"
                action={<Link className="price-button" to="/signup">Create a free account <Icon name="arrow" size={17} /></Link>}>
                <Check>Unlimited chats and groups</Check>
                <Check>Unlimited shared expenses</Check>
                <Check>Multi-currency and settle-up links</Check>
                <Check>Monthly AI receipt scan allowance</Check>
              </PricingCard>
              <PricingCard plus soon={!pro?.payments_enabled} title="ShareEven Pro"
                price={proPrice ? formatPrice(proPrice.monthly, currency) : 'More ease.'} per={proPrice ? 'a month' : undefined}
                note={proPrice ? `or ${formatPrice(proPrice.yearly, currency)} a year (${formatPrice(perMonth(proPrice.yearly), currency)} a month). Paid once, never renews by itself. Prices include taxes.` : undefined}
                action={pro?.payments_enabled ? (
                  <Link className="price-button" to={user ? '/settings/plan' : '/signup'}>Get Pro <Icon name="arrow" size={17} /></Link>
                ) : (
                  <a className="price-button disabled" href="mailto:support@shareeven.com?subject=ShareEven%20Pro%20waitlist">Join the waitlist <Icon name="arrow" size={17} /></a>
                )}>
                {(pro?.features || ['Many more receipt scans every month', 'Everything in Free', 'Support the people building ShareEven'])
                  .map((f) => <Check key={f}>{f}</Check>)}
              </PricingCard>
            </div>
          </div>
        </section>

        <section className="section faq-section" id="faq">
          <div className="page-shell faq-grid">
            <div className="faq-intro">
              <span className="eyebrow">Good to know</span>
              <h2>Questions, answered.</h2>
              <p>The important things, without the fine-print fog.</p>
              <ArrowLink to="/faq">All questions</ArrowLink>
            </div>
            <div className="faq-list">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <article className={`faq-row ${isOpen ? 'open' : ''}`} key={faq.q}>
                    <button type="button" aria-expanded={isOpen} onClick={() => setOpenFaq(isOpen ? null : index)}>
                      <span>{faq.q}</span>
                      <Icon name={isOpen ? 'x' : 'chevron'} size={19} />
                    </button>
                    {isOpen && <p>{faq.a}</p>}
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="cta-section">
          <div className="page-shell">
            <div className="cta-band">
              <div className="cta-ring ring-one" />
              <div className="cta-ring ring-two" />
              <div>
                <span>FAIR SHARES. BETTER CHATS.</span>
                <h2>Ready to stop doing the maths?</h2>
                <p>Make the next plan simpler from the very first message.</p>
              </div>
              <Link to="/signup">Get started free<Icon name="arrow" size={18} /></Link>
            </div>
          </div>
        </section>

        <footer>
          <div className="page-shell footer-top">
            <div className="footer-brand">
              <Logo />
              <p>Private conversations. Fair shares.</p>
            </div>
            <nav aria-label="Footer navigation">
              <Link to="/about">About</Link>
              <Link to="/faq">FAQ</Link>
              <Link to="/contact">Contact us</Link>
              <Link to="/terms">Terms of Service</Link>
              <Link to="/privacy">Privacy Policy</Link>
            </nav>
          </div>
          <div className="page-shell footer-bottom">
            <span>© {new Date().getFullYear()} ShareEven</span>
            <span className="footer-lock"><Icon name="lock" size={13} />Built for privacy</span>
          </div>
        </footer>
      </main>
    </div>
  );
};

export default Landing;
