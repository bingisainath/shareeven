// src/content/infoPages.ts
// About, FAQ, Contact, Terms of Service and Privacy Policy. One source for the web pages at
// /about, /faq, /contact, /terms and /privacy; the Android app opens those same pages.
//
// OPERATOR is who runs ShareEven (by law the "data controller"): a sole proprietor, the same name and
// address as the Razorpay KYC. Have a lawyer read the Terms and the Privacy Policy before launch.
// These describe what the code does today; change them when that changes (a new provider, analytics,
// prices or refund rules), and update LAST_UPDATED.

export const OPERATOR = {
  name: 'Sainath Bingi',
  // How the law sees ShareEven: run by one person, not a company. Change it here if that changes.
  form: 'as a sole proprietor',
  address: '36/21 Rajiv Gruha Kalpa, Jagathgirigutta, Hyderabad 500037, Telangana, India',
  country: 'India', // governing law and courts
  grievanceOfficer: 'Sainath Bingi', // India's DPDP Act asks for one
};

export const CONTACT = {
  support: 'support@shareeven.com',
  privacy: 'privacy@shareeven.com',
  security: 'security@shareeven.com',
};

export const LAST_UPDATED = '20 October 2026';

/** A paragraph, or a bulleted list when it's an array. Email addresses become links. */
export type Block = string | string[];

export interface InfoSection {
  heading?: string;
  body: Block[];
}

export interface InfoPage {
  slug: 'about' | 'faq' | 'contact' | 'terms' | 'privacy';
  label: string; // link text
  title: string;
  intro?: string;
  dated?: boolean; // shows "Last updated"
  sections: InfoSection[];
}

const about: InfoPage = {
  slug: 'about',
  label: 'About',
  title: 'About ShareEven',
  intro: 'Chat privately. Split fairly. ShareEven is one app for talking with your people and keeping shared money fair.',
  sections: [
    {
      heading: 'What it does',
      body: [[
        'Private chats and groups, with photos, videos, voice notes and files, end-to-end encrypted.',
        'Shared expenses in any chat: split equally, by amounts, by shares or item by item.',
        'Receipt scanning: photograph a bill and AI reads the items, discounts and total, so you only assign who had what.',
        'Balances in many currencies, with the fewest payments needed to settle up.',
        'Pay buttons that open UPI, Revolut, PayPal and similar apps with the amount filled in. ShareEven never holds or moves money.',
      ]],
    },
    {
      heading: 'Privacy first',
      body: [
        'Your messages and media are encrypted on your device and can only be read on the devices you link. We can\'t read them, and neither can anyone who gets into our servers.',
        'No ads, no selling your data, no tracking across other apps and websites.',
      ],
    },
    {
      heading: 'Who we are',
      body: [
        `ShareEven is a small independent product made for friends, flatmates, couples and travellers in Europe and India. Questions or ideas? Write to ${CONTACT.support}.`,
      ],
    },
  ],
};

const faq: InfoPage = {
  slug: 'faq',
  label: 'FAQ',
  title: 'Frequently asked questions',
  sections: [
    {
      heading: 'Is ShareEven free?',
      body: ['Yes. Chats, groups and expenses are free, and receipt scanning includes a free allowance every month. ShareEven Pro is an optional paid plan with more receipt scans a month; it also helps keep ShareEven independent and ad-free. Prices include taxes.'],
    },
    {
      heading: 'Does Pro renew by itself? How do I cancel it?',
      body: [
        'Pro doesn\'t renew, so there\'s nothing to cancel. It\'s paid once for a month or a year, and you\'re never charged again unless you choose to pay again. We remind you 7 days and 1 day before it ends.',
        'When it ends you go back to Free: your chats, groups and expenses stay exactly as they are, and only the monthly receipt scans go back to the free allowance. Paying again before the end adds the time after your current end date, so you don\'t lose any days.',
      ],
    },
    {
      heading: 'Can I get a refund for Pro?',
      body: [`Yes, if you paid by mistake or something went wrong: write to ${CONTACT.support} from the email address on your ShareEven account, with the payment ID from your payment receipt (it starts with "pay_"). The money goes back the way you paid within 3 to 7 working days, and Pro is shortened by the time that was refunded.`],
    },
    {
      heading: 'Can ShareEven read my messages?',
      body: ['No. Messages, photos, videos, voice notes and files are end-to-end encrypted: only the devices you and the people in the chat have linked can open them. Our servers only pass along and store locked copies.'],
    },
    {
      heading: 'What isn\'t end-to-end encrypted?',
      body: ['Expenses, balances and payments you record, and receipt photos you scan, are stored on our servers so every member sees the same numbers and the AI can read the receipt. They\'re protected in transit and on our servers, and only members of that chat can see them.'],
    },
    {
      heading: 'Does ShareEven move money?',
      body: ['No. ShareEven keeps track of who owes whom. When you pay someone (by UPI, bank transfer, Revolut, cash or anything else), you record the payment and the balance updates. Pay buttons just open your payment app with the amount filled in.'],
    },
    {
      heading: 'How do I use ShareEven on another phone or computer?',
      body: [
        'Sign in on the new device. It shows a number, and every device you\'re already signed in on asks "Is this you?". Tap the same number there and the new device is linked. If it isn\'t you, tap "Not me" (a wrong number turns it down too).',
        'For the strongest check, tap "Use a code instead" on the new device and scan its QR code or type its code in Settings → Linked devices. The number check stops a mistaken or unexpected approval, and the code also proves the two devices talked to each other directly. If you turned on backup, you can restore your chats with your recovery key instead.',
      ],
    },
    {
      heading: 'I lost my phone. Are my chats gone?',
      body: ['If you turned on backup, sign in on your new phone and restore with your recovery key. If you didn\'t, and no other device is signed in, the encrypted chats can\'t be recovered (not even by us), but your groups, expenses and balances are all still there.'],
    },
    {
      heading: 'How accurate is receipt scanning?',
      body: ['Usually very good, but always check the items and total before saving. You can edit anything the AI read, and the app warns you when the items don\'t add up to the total.'],
    },
    {
      heading: 'How do currencies work?',
      body: ['Each expense keeps the currency it was paid in. Balances are kept per currency, and you can choose to also see totals converted at the latest daily exchange rate, which is an estimate.'],
    },
    {
      heading: 'How do I block or report someone?',
      body: ['Open the chat, tap its name, then Block or Report. To report one message, long-press it (on the web, use the flag next to it). The person isn\'t told.'],
    },
    {
      heading: 'How do I delete my account or download my data?',
      body: ['Settings → Download my data gives you a file with everything we hold about you. Settings → Delete account removes your account right away. Shared expenses stay as "Deleted user" so other people\'s balances don\'t change.'],
    },
  ],
};

const contact: InfoPage = {
  slug: 'contact',
  label: 'Contact us',
  title: 'Contact us',
  intro: 'We\'re a small team and read every message. We usually reply within two working days.',
  sections: [
    { heading: 'Help and feedback', body: [`Questions, problems or ideas: ${CONTACT.support}`] },
    { heading: 'Privacy and your data', body: [`Requests about your personal data, or complaints for our grievance officer (${OPERATOR.grievanceOfficer}): ${CONTACT.privacy}`] },
    { heading: 'Abuse', body: ['To report a person, message or group, use Report in the app so we get the details we need. If it\'s urgent, also write to ' + CONTACT.support + '.'] },
    { heading: 'Security', body: [`Found a security problem? Please tell us privately at ${CONTACT.security} before sharing it publicly.`] },
    { heading: 'Postal address', body: [`ShareEven (run by ${OPERATOR.name}), ${OPERATOR.address}`] },
  ],
};

const terms: InfoPage = {
  slug: 'terms',
  label: 'Terms of Service',
  title: 'Terms of Service',
  dated: true,
  intro: `These terms are an agreement between you and ShareEven ("we", "us") for using the ShareEven apps and website. ShareEven is run by ${OPERATOR.name} ${OPERATOR.form} in ${OPERATOR.country} (${OPERATOR.address}). By creating an account you accept them.`,
  sections: [
    {
      heading: '1. Who can use ShareEven',
      body: ['You must be at least 18 years old, and able to make a binding agreement where you live. One person per account; keep your password and devices secure, and tell us if you think someone else has access.'],
    },
    {
      heading: '2. Your content',
      body: ['What you send and upload stays yours. You give us only the permission we need to store it, send it to the people you chose and run the app (for example, passing a receipt photo to the AI that reads it). You\'re responsible for what you share and must have the right to share it.'],
    },
    {
      heading: '3. Acceptable use',
      body: ['Don\'t use ShareEven to:', [
        'harass, threaten, scam or impersonate anyone, or send spam;',
        'share content that is illegal, sexually exploits children, or promotes violence or hatred;',
        'break the law, including money laundering and fraud;',
        'attack, overload, scrape or reverse-engineer the service, or get around its limits or security.',
      ], 'We may remove content we\'re told about, and limit, suspend or close accounts that break these rules.'],
    },
    {
      heading: '4. Expenses and payments',
      body: [
        'ShareEven is a record-keeping tool. It doesn\'t hold, send or receive money, and isn\'t a bank or payment service.',
        'Members add expenses, splits and payments themselves, and whoever adds or changes one is responsible for getting it right. ShareEven doesn\'t check that an expense is real, that its amount or split is correct, or that a recorded payment was really made. Check an expense before you add it, and check your balances before you pay or settle up.',
        'If members disagree about who owes what, that\'s between them. Each expense\'s history shows who added and changed it, and it can be edited or deleted in the chat. We can\'t settle disputes between members or move money for anyone.',
        'Payments you make through other apps (UPI, bank transfer, Revolut, PayPal) are between you and those services. Converted totals use daily exchange rates and are estimates.',
      ],
    },
    {
      heading: '5. Receipt scanning',
      body: [
        'Receipts are read by AI and can contain mistakes. Check the result before saving it.',
        'Scans are limited each month, and the limit can differ between accounts: we may give testers or people whose scan went wrong extra scans, and we may lower or pause scanning for an account that misuses it. We won\'t lower what you paid for during a billing period. ShareEven Pro is covered in section 6.',
      ],
    },
    {
      heading: '6. ShareEven Pro, payments and refunds',
      body: [[
        'What it is: ShareEven Pro is an optional plan that gives more receipt scans each month. Everything else in ShareEven stays free.',
        'Price: the price is shown before you pay, in Indian rupees (or the currency shown to you), and includes any applicable taxes. A change in price never affects time you have already paid for.',
        'Payment: you pay once, through our payment partner Razorpay, for one month or one year. We never see your card, UPI or bank details.',
        'No automatic renewal: Pro is not a subscription. It is never charged again on its own, so there is nothing to cancel. We remind you 7 days and 1 day before it ends. Paying again before then adds the new time after your current end date. When it ends, your account goes back to Free and keeps all your chats, groups and expenses.',
        `Delivery: Pro is a digital service and nothing is shipped. It turns on as soon as the payment is confirmed, usually straight away. If it hasn't turned on within an hour of paying, write to ${CONTACT.support}.`,
        `Refunds: if you paid by mistake, were charged twice, or Pro didn't work as described, write to ${CONTACT.support} from the email address on your account, with the payment ID from your receipt (it starts with "pay_"). Approved refunds go back the way you paid within 3 to 7 working days, and Pro is shortened by the time that was refunded. A payment that failed but was taken from your account is refunded in full.`,
        'If we stop offering Pro, we refund the unused part of what you paid. If we close your account for breaking these terms, the unused part may not be refunded where the law allows that.',
      ]],
    },
    {
      heading: '7. End-to-end encryption',
      body: ['Your messages are encrypted with keys only your devices hold. If you lose all your signed-in devices and your recovery key, we can\'t recover your messages.'],
    },
    {
      heading: '8. Availability and changes',
      body: ['We work to keep ShareEven running and your data safe, but the service is provided "as is" and may sometimes be unavailable. We may change or stop features. For important changes to these terms we\'ll tell you in the app or by email before they apply.'],
    },
    {
      heading: '9. Closing your account',
      body: ['You can delete your account at any time in Settings. We may suspend or close accounts that break these terms or the law, and will tell you why unless the law or safety prevents it.'],
    },
    {
      heading: '10. Liability',
      body: ['As far as the law allows, we aren\'t liable for indirect losses, or for losses from relying on balances, AI results or exchange rates, or from payments you make outside ShareEven. Nothing in these terms limits rights you have under consumer law that can\'t be limited.'],
    },
    {
      heading: '11. Law and disputes',
      body: [`These terms are governed by the laws of ${OPERATOR.country}. If you live in the EU or UK, you also keep the protection of your own country's consumer law and can bring a claim there. Please contact us first at ${CONTACT.support}; most problems can be solved quickly.`],
    },
  ],
};

const privacy: InfoPage = {
  slug: 'privacy',
  label: 'Privacy Policy',
  title: 'Privacy Policy',
  dated: true,
  intro: `This policy explains what ShareEven collects, why, and what you can do about it. ShareEven, run by ${OPERATOR.name} ${OPERATOR.form} (${OPERATOR.address}), is responsible for your data (the "data controller" or "data fiduciary").`,
  sections: [
    {
      heading: 'What we can\'t see',
      body: ['Your messages, photos, videos, voice notes and files are end-to-end encrypted. We store and deliver locked copies, but we don\'t have the keys and can\'t read them. Your optional chat backup is locked with a recovery key that only you have.'],
    },
    {
      heading: 'What we collect',
      body: [[
        'Account: username, email address, password (stored only as a secure hash), and what you add to your profile: name, photo, bio, payment usernames (such as a UPI ID) and preferred currency.',
        'Chats: which chats and groups you\'re in, group names and photos, and when messages were sent and delivered. Not what they say.',
        'Expenses: the expenses, splits and payments recorded in your chats, and receipt photos you scan with what the AI read from them.',
        'Devices and sign-ins: the device or browser name, when it signed in and was last active, the public keys used for encryption, and a notification token if you allow notifications.',
        'Payments for ShareEven Pro: the plan, amount, currency and date, and the order and payment IDs from Razorpay. Your card, UPI or bank details go straight to Razorpay; we never see them.',
        'Safety: people you\'ve blocked, and reports you send (including a message\'s text only if you choose to share it).',
        'Technical: IP addresses, used briefly to stop abuse (such as password guessing), and error logs.',
      ]],
    },
    {
      heading: 'Why we use it',
      body: [[
        'To provide ShareEven: deliver messages, keep balances, read receipts, send sign-in codes and notifications (contract).',
        'To keep it safe: stop spam, abuse and break-ins, and review reports (legitimate interest, and legal obligations).',
        'Optional features you switch on, such as notifications (consent, which you can withdraw in Settings or your phone\'s settings).',
      ], 'We don\'t show ads, sell your data, or use it to profile you for anyone else.'],
    },
    {
      heading: 'Who we share it with',
      body: ['Only the service providers ShareEven needs, under contracts that limit what they can do with it:', [
        'Hosting and storage, where our servers and your files are kept.',
        'Google Firebase Cloud Messaging, to deliver notifications. Notifications show who sent a message and the chat name, not what encrypted messages say.',
        'Our email provider, to send sign-in codes and password resets.',
        'Razorpay, when you pay for ShareEven Pro: it receives your payment details and the name, email and phone number you give at checkout, to take the payment, prevent fraud and meet its legal duties as a payment service in India.',
        'Anthropic, when you scan a receipt: the receipt photo is sent to its AI to read it. It doesn\'t use it to train its models.',
      ], 'We share data with authorities only when the law requires it, and we can only hand over what we have. That never includes the content of encrypted messages.'],
    },
    {
      heading: 'Where it\'s stored',
      body: ['Some providers may process data outside your country. When data leaves the EU or India, we use the safeguards the law requires, such as the EU\'s Standard Contractual Clauses.'],
    },
    {
      heading: 'How long we keep it',
      body: ['As long as your account exists. When you delete your account, your profile, devices, keys, backup, settings and what your messages said are removed straight away; server backups are overwritten within 30 days. Expenses and payments you shared with others are kept, shown as "Deleted user", because they\'re part of other people\'s records. Records of what you paid for ShareEven Pro are kept for as long as tax and accounting law requires, without your profile.'],
    },
    {
      heading: 'Your rights',
      body: [[
        'See and download your data: Settings → Download my data.',
        'Correct it: edit your profile at any time.',
        'Delete it: Settings → Delete account.',
        'Object, restrict, or withdraw consent; and, in India, nominate someone to act for you.',
      ], `For anything else, or a complaint, write to ${CONTACT.privacy} (grievance officer: ${OPERATOR.grievanceOfficer}). We reply within 30 days. You can also complain to your data protection authority in the EU, or to the Data Protection Board of India.`],
    },
    {
      heading: 'Children',
      body: ['ShareEven is for people 18 and over. If we learn that a child has an account, we\'ll delete it.'],
    },
    {
      heading: 'Security',
      body: ['End-to-end encryption for messages and media, encrypted connections (HTTPS), uploaded files encrypted on our servers, hashed passwords, and limits against password guessing. No system is perfect; if a breach affects you, we\'ll tell you and the authorities as the law requires.'],
    },
    {
      heading: 'Changes',
      body: ['We\'ll update this page when what we do changes, and tell you in the app or by email before important changes apply.'],
    },
  ],
};

export const INFO_PAGES: InfoPage[] = [about, faq, contact, terms, privacy];

export const infoPage = (slug: string) => INFO_PAGES.find((p) => p.slug === slug);
