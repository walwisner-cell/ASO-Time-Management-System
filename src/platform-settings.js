const db = require('./db');

// Sensible defaults for every setting this app currently has — used
// whenever no row exists yet in the database (nothing has been changed
// from default). This is the same "DB row overrides code default"
// convention used everywhere else in this app (plan pricing, exchange
// rates, category active-toggles).
const DEFAULTS = {
  // The real WhatsApp number and display phone number shown to visitors
  // (homepage, and the "talk to a real person" path in the support chat).
  // Starts as an obviously-fake placeholder until a real super admin sets
  // the actual number in Settings — isPlaceholder (computed where this is
  // read, not stored here) tells the frontend whether what it's showing
  // is still this placeholder, so it can be honest about it rather than
  // silently presenting a fake number as real.
  supportContact: {
    whatsapp: '15551234567',
    phoneDisplay: '+1 (555) 123-4567',
    email: '',
  },
  // The site-wide footer line ("© 2026 [company] · [location] · [email]"),
  // hardcoded in five places in public/index.html until now. This was
  // flagged as wrong (a placeholder company name/city that was never the
  // real one) with no way to fix it without a code change — this makes it
  // a real, admin-editable setting instead, the same "DB overrides code
  // default" pattern as everything else here. copyrightYear is a plain
  // number, not auto-computed, so it doesn't silently drift wrong at a
  // year boundary without a super admin actually choosing to update it.
  footerInfo: {
    companyName: 'Trothen Tech Group',
    location: 'Atlanta, GA',
    supportEmail: 'support@trothen.io',
    copyrightYear: 2026,
  },
  // How long a provider has to accept or decline a new booking (direct or
  // a Mutual Agreement offer) before it auto-expires and the customer is
  // refunded — tiered by how soon the job actually is, not a flat number.
  // Real-world comparables: Uber/Lyft give a driver ~15 seconds (the ride
  // starts now); Airbnb's Request-to-Book gives a host 24 hours (bookings
  // are usually days/weeks out). Local home-services jobs span both
  // extremes — someone booking an emergency plumber this afternoon needs a
  // fast provider response; someone booking a mover for next month doesn't
  // need the provider glued to their phone. A single flat window can't
  // serve both well, so this scales with lead time instead.
  bookingResponseTiers: {
    within24h: 1,  // job starts within 24 hours — respond within 1 hour
    within7d: 4,   // job starts within 2–7 days — respond within 4 hours
    beyond7d: 24,  // job starts more than a week out — respond within 24 hours
  },

  // The homepage support chat's "Chat with us" / "Call" links. Ships with
  // an obviously-fake placeholder number on purpose — flagged in every
  // audit rather than silently invented — until a super admin sets the
  // real one here. whatsapp is digits only (country code, no +/spaces/
  // dashes, e.g. "15551234567"); phoneDisplay is whatever human-readable
  // format should actually show on screen.
  // Long-form editable pages — About Us and the Terms of Service. Support
  // a small set of plain-text formatting markers (parsed client-side by
  // renderFormattedContent in public/index.html): a line starting with
  // "# " becomes a section heading, "- " becomes a bullet, "**text**"
  // becomes bold, and a blank line starts a new paragraph. Deliberately
  // not a full WYSIWYG/HTML editor — that would need real sanitization
  // against a much larger attack surface for content only a trusted
  // super admin ever edits; this gives genuine structure (headings,
  // emphasis, lists) with a parser simple enough to reason about
  // completely.
  aboutUsContent: `# Built to make hiring someone feel safe again

Trothen started with a simple frustration: hiring a plumber, a tutor, or a mover in your own neighborhood shouldn't feel like a gamble. Across every market we operate in — Atlanta to Lagos to Accra — the same problem kept coming up: no way to know who's really showing up, and no real recourse if something goes wrong.

So we built a platform where every professional is identity-verified before they can accept a single job, every booking runs on an auto-generated contract, and your payment sits safely in escrow until the work is actually done. Trust shouldn't be something you hope for — it should be the default.

We're a small, distributed team building this because we've personally been on both sides of a bad hire and a missed payment. We're still early, and we're building this in the open — if something's not working the way it should, we want to hear about it.`,

  termsOfServiceCustomerContent: `Trothen Terms of Service — Customers

Last updated: [set this date when you actually publish these terms]

# 1. Who These Terms Are Between

These Terms of Service ("Terms") govern your use of Trothen (the "Platform") as a Customer, operated by Trothen Tech Group ("Trothen," "we," "us"). By creating a Customer account, you agree to these Terms. If you don't agree, don't use the Platform.

# 2. What Trothen Is — and Isn't

Trothen is a marketplace that connects you with independent Providers who perform local services. **Trothen does not perform the services listed on the Platform, and does not employ the Providers who do.** We verify Provider identity before they can accept work, hold your payment in escrow, generate a contract for every booking, and provide dispute support — we are not a party to the actual work performed.

# 3. Account Eligibility

You must be at least 18 years old and able to form a binding contract to use Trothen. You're responsible for keeping your login credentials secure and for everything that happens under your account. Provide accurate information when you register, and keep it up to date.

# 4. What You Agree To As a Customer

- **Keep what you promised** — be there for the window you booked, or say so early if plans change.
- **Be honest** — describe the job accurately, including anything difficult about it, and rate honestly on what actually happened.
- **Be safe** — disclose hazards before a job (pets, structural issues, chemicals) so your Provider can work safely.
- **Treat people with respect** — Providers are independent professionals running their own businesses, not staff, and not yours to direct beyond what the job describes.
- **Keep it on the platform** — arrange and pay for work through Trothen. Off the platform, there is no payment protection, for either side.

# 5. Payment, Fees, and Escrow

When you book a job, your payment is held in escrow until you confirm the work is complete, at which point funds release to the Provider. Any applicable Customer service fee is shown to you before you confirm a booking — the Platform will always display the actual, current fee, never a hidden charge added afterward.

# 6. Cancellations

You may cancel a booking before it's completed, subject to the cancellation terms shown on the Platform at the time of booking.

# 7. Prohibited Activity

The following can never be posted or booked on Trothen, regardless of category: transporting people, unsupervised care of minors, work involving weapons or controlled substances, medical or veterinary procedures, or handling of hazardous or biological waste. Trothen may remove any listing or booking that violates this, and may suspend the account responsible.

# 8. Disputes

If something goes wrong with a job, contact Trothen support. A real person reviews every dispute — no automated system makes a final call on a dispute. Response-time targets for different types of issues are published on the Platform.

# 9. Account Suspension

Trothen may suspend or terminate your account for violating these Terms or applicable law. Every such decision is made by a person, not an algorithm, and can be questioned — contact support if you believe a decision was made in error.

# 10. Limitation of Liability

Trothen provides the Platform "as is." To the maximum extent permitted by law, Trothen is not liable for the acts or omissions of Providers, or for indirect, incidental, or consequential damages arising from use of the Platform. Nothing in these Terms limits liability where the law does not allow it to be limited.

# 11. Changes to These Terms

Trothen may update these Terms from time to time. If a change is material, you'll be asked to review and accept the updated Terms before continuing to use the Platform.

# 12. Identity Checks and Your ID Document

Before your first booking, we ask for a photo of a government-issued ID and a photo of your face. A person on the Trothen team compares the two and checks the name against your account. If we use an automated identity service instead, it does the same comparison and reports the result to us.

Your ID and face photo are stored privately. They are never shown to other users. Only Trothen staff who review identity checks can open them, and every time one is opened it is recorded. {{ID_RETENTION_SENTENCE}} We keep a record that the check happened: the type of document, the name on it, the decision, and who made it.

# 13. Contact

Questions about these Terms: {{SUPPORT_EMAIL}}`,

  termsOfServiceProviderContent: `Trothen Terms of Service — Providers

Last updated: [set this date when you actually publish these terms]

# 1. Who These Terms Are Between

These Terms of Service ("Terms") govern your use of Trothen (the "Platform") as a Provider, operated by Trothen Tech Group ("Trothen," "we," "us"). By creating a Provider account, you agree to these Terms. If you don't agree, don't use the Platform.

# 2. What Trothen Is — and Isn't

Trothen is a marketplace that connects you with Customers who need local services. **Trothen does not perform the services you list, and does not employ you.** We verify your identity before you can accept work, hold Customer payment in escrow until a job is confirmed complete, generate a contract for every booking, and provide dispute support — we are not a party to the actual work you perform.

# 3. Your Relationship With Trothen

You are an independent contractor, not an employee, agent, partner, or joint venturer of Trothen. **Nothing in these Terms creates an employment relationship.** You choose which jobs to accept, when to work, and how the work gets done — Trothen never directs your method, hours, route, or acceptance decisions. You are responsible for your own taxes, insurance, and business expenses.

# 4. Account Eligibility

You must be at least 18 years old and able to form a binding contract to use Trothen. You're responsible for keeping your login credentials secure — never lend your account to anyone else — and for everything that happens under it. Provide accurate information when you register, and keep it up to date, including any license or insurance information your category requires.

# 5. What You Agree To As a Provider

- **Keep what you promised** — show up for the window you accepted, or say so early if you can't.
- **Be honest** — describe your work accurately. If a job needs a licensed trade or is bigger than described, stop and tell the Customer.
- **Be safe** — never work impaired or endangered. Stop and report if a job becomes unsafe — no job is worth an injury.
- **Treat people with respect** — no harassment, discrimination, or unwanted contact. Never enter a space you weren't invited into.
- **Keep it on the platform** — arrange and get paid for work through Trothen. Off the platform, there is no payment protection, for either side.

# 6. Commission and Payment

Trothen deducts a commission from each completed job before paying you out; the current rate for your tier is always shown on your dashboard and on each payout. Rates may change from time to time, and the Platform will always reflect the actual, current rate — never a rate you weren't shown.

# 7. Cancellations

You may cancel a job before it's completed, subject to the cancellation terms shown on the Platform. **Cancelling because a job wasn't accurately described, became unsafe, needed a different trade, or required a license you don't hold will never count against your standing on the Platform** — that's a system rule, not a case-by-case judgment call.

# 8. Prohibited Activity

The following can never be posted, accepted, or performed through Trothen, regardless of category: transporting people, unsupervised care of minors, work involving weapons or controlled substances, medical or veterinary procedures, or handling of hazardous or biological waste. Trothen may remove any listing or booking that violates this, and may suspend the account responsible.

# 9. Disputes

If something goes wrong with a job, contact Trothen support. A real person reviews every dispute — no automated system suspends your account or makes a final call on a dispute. Response-time targets for different types of issues are published on the Platform.

# 10. Account Suspension

Trothen may suspend or terminate your account for violating these Terms, the Community Standards, or applicable law. Every such decision is made by a person, not an algorithm, and can be questioned — contact support if you believe a decision was made in error.

# 11. Limitation of Liability

Trothen provides the Platform "as is." To the maximum extent permitted by law, Trothen is not liable for indirect, incidental, or consequential damages arising from use of the Platform. Nothing in these Terms limits liability where the law does not allow it to be limited.

# 12. Changes to These Terms

Trothen may update these Terms from time to time. If a change is material, you'll be asked to review and accept the updated Terms before continuing to use the Platform.

# 13. Identity Checks and Your ID Document

Before you appear in search or accept work, we ask for a photo of a government-issued ID and a photo of your face. A person on the Trothen team compares the two and checks the name against your account. If we use an automated identity service instead, it does the same comparison and reports the result to us.

Your ID and face photo are stored privately. They are never shown to other users. Only Trothen staff who review identity checks can open them, and every time one is opened it is recorded. {{ID_RETENTION_SENTENCE}} We keep a record that the check happened: the type of document, the name on it, the decision, and who made it.

# 14. Contact

Questions about these Terms: {{SUPPORT_EMAIL}}`,

  // v94: the built-in Privacy Policy. It describes what the system really
  // does, in plain words. It is editable in Admin → Settings, and an
  // attorney should review it before launch. {{ID_RETENTION_SENTENCE}} and
  // {{SUPPORT_EMAIL}} are filled in from live settings when it is shown.
  privacyPolicyContent: `Trothen Privacy Policy

Last updated: 7 October 2026

# 1. What This Covers

This policy explains what information Trothen collects when you use the site as a customer or as a pro, why we collect it, who can see it, how long we keep it, and the choices you have. We have tried to write it so you can read it once and understand it.

# 2. What We Collect

Account details. Your name, email address, phone number, country, state or region, city, address and postal code, and a password. Your password is stored in a scrambled form that nobody at Trothen can read. If you sign in with Google, we receive your name and email address from Google.

Identity check. To confirm who you are, we ask for a photo or PDF of a government ID (front, and back if it has one), the name printed on it, and a photo of your face. A person on the Trothen team compares them.

Guarantors (pros only, optional). If you name people who can vouch for you, we store their names and phone numbers and may call them. Please tell them first.

Jobs and bookings. What you ask for or agree to do, the price, dates and times, photos or videos you attach, the written agreement for each booking, reviews, and any dispute and the evidence either side uploads.

Stores and business tools (pros only, optional). If you open a store: its name, your goods, their photos and prices, and your stock. If you use the business tools: the quotes, estimates and invoices you write (including the customer name and contact you type in), your list of tools, and your expenses and receipt photos. Only you can see your business records, except a quote, estimate or invoice you choose to send to a customer on Trothen, which that customer can also see. Your store name is public, and your goods and prices are shown to anyone who opens your store once a Trothen manager has approved them. If you add a skill in a licensed trade, the licence photo you attach is kept privately and only the Trothen staff who check it can open it.

Location. See section 3.

Payments. Trothen is in early access and payments are in test mode, so no real money moves yet. We record the amounts for each booking. For a saved card we keep only the brand, the last four digits and the expiry date. We never store a full card number or security code.

Messages and support. Messages you exchange with the other person on a booking, and what you write to our support team or type into the support chat.

Technical information. The date and time of your sign-ins, the kind of device or browser, and your internet address, which we use to protect accounts and stop abuse. The site keeps a sign-in token and your language choice in your browser's storage. We do not use advertising trackers.

# 3. Location

We only use your location when you choose to share it.

Job location. When you post a job or book a pro, you can pin where the job is (often your home) and add a landmark. Only the pro you hire, and Trothen staff who need it, can see the exact spot. Pros who are only matched to your job see a rounded distance, not the spot.

Searching. If you press the location button when searching, your position is used to sort pros by distance. It is not saved to your account.

A pro's base location. A pro can share where they are based so customers see a real distance. A pro can remove it at any time in Settings.

Live trip. When a pro taps "On my way", their position is shared with that one customer until they tap "Arrived". It is not shared before or after, and the live position is deleted on arrival. We keep the point where the pro said they set off and the point where they said they arrived, to help settle disputes and detect fraud.

Pick-up and drop-off. When goods or materials are carried as part of a booking, the customer or the pro can take photos at pick-up and at drop-off. Each record keeps who took it, when, and where the phone was, if the phone gives a position. From the pro's pick-up record until the pro's drop-off record, the pro's phone also records the route taken, while the Trothen page is open. Only the customer and the pro on that booking, and Trothen staff handling a dispute, can see these.

Store orders and delivery. When you buy goods from a pro's store, the seller sees your first name, what you bought and any note you write. If you ask for the goods to be brought to you, the place you give (a pin, a landmark or an address) is shown to whoever brings them: the seller if the seller delivers, or the driver you chose. When a driver delivers, the seller is not shown your address. A store's collection place, and its pin if the seller set one, are shown to customers who order from it and to the driver. A driver's name, what they deliver with, their rating and their price are shown to customers choosing a driver; a driver's own position is never shown.

Maps. When a map is shown, the map pictures come from OpenStreetMap, and links can open Google Maps. Those services receive your internet address and the area of the map you are viewing, as with any website.

You can switch location off for this site in your browser or phone settings. You can then type a location, choose it on a map, or describe a landmark instead.

# 4. Why We Use It

To create and protect your account. To check identity, so people can trust who they are dealing with. To match customers with pros and let them agree, carry out and pay for a job. To help a pro find the job. To settle disputes fairly. To detect and prevent fraud and abuse. To send you messages about your bookings and your account. To meet legal obligations.

We do not sell your personal information.

# 5. Who Can See Your Information

Other users. A pro's public profile shows their name, photo, city, skills, reviews and score. A customer and a pro on the same booking see each other's name and what is needed to do the job, including the job location. Your ID, your face photo and your contact details are never shown to other users by Trothen.

Trothen staff. Only staff who need the information for their job can see it. ID documents and face photos can be opened only by the staff who review identity checks, and every time one is opened it is recorded.

Companies that help us run the service, each only when that service is switched on and only for its purpose: our hosting provider, which stores the data in the United States; an email delivery service; a text message service; Google, if you choose to sign in with Google; an identity verification service, if we use automated checks; OpenStreetMap for map pictures; a mobile money partner, where mobile money payments are offered; and, if our AI support assistant is switched on, the questions you type into the support chat are sent to an AI provider to produce an answer.

Authorities. We may disclose information when the law requires it, or to protect someone's safety.

# 6. How Long We Keep It

ID documents and face photos. {{ID_RETENTION_SENTENCE}} If a dispute or a fraud review involving your account is open at that time, the files are kept until it is closed. We keep a record that the check happened: the type of document, the name on it, the decision, and who made it.

Live trip position. Deleted when the pro arrives.

Job location. The exact pin, and the points where the pro said they set off and arrived, are removed 90 days after a booking ends, unless a dispute on it is still open. For a job post that never became a booking, the pin and landmark are removed after 30 days.

Pick-up and drop-off. The positions on pick-up and drop-off records, and the recorded route, are removed on the same 90-day rule. The photos and times stay with the booking as the record of the hand-over.

Sign-ups that are started and not finished. Deleted within about an hour.

Your account and its records. Kept while your account is open. If you close your account, it stops working at once. Trothen then removes your name, contact details, photos and ID files. Records of bookings, payments, reviews and disputes are kept, without your personal details, because the other person involved has a right to their record and because the law requires financial records to be kept.

# 7. Your Choices

Download your data. In Settings, "Download my data" gives you a file with what Trothen holds about your account.

Close your account. In Settings, "Close my account". You cannot close it while a booking, a held payment or a dispute is still open.

Correct your details. You can edit your profile in Settings.

Location and notifications. You can switch these off in your browser or phone settings.

Depending on where you live, you may have further rights under your local data protection law, such as the right to object or to complain to your data protection authority. Contact us and we will help.

# 8. Security

Passwords are scrambled. ID files are kept in a private area, are not served to the public, and can be encrypted on our disk. Every request is checked so that people can reach only their own bookings, messages and files. Sign-in is paused after repeated wrong passwords. No system is perfectly secure, and we cannot promise that information will never be accessed wrongly, but we work to prevent it and will tell you if a breach affects you.

# 9. Age

Trothen is for people aged 18 or over. We do not knowingly collect information from anyone under 18.

# 10. Where Your Information Is Stored

Our servers are in the United States. If you use Trothen from another country, your information is transferred to and stored in the United States.

# 11. Changes to This Policy

If we change this policy in a way that matters, we will tell you on the site before the change takes effect.

# 12. Contact

Questions about this policy, or a request about your own information: {{SUPPORT_EMAIL}}. We aim to reply within 30 days.`,

  // v77: how many days an uploaded ID and selfie are kept after a decision
  // (approved, rejected or replaced). 0 = keep until deleted by hand.
  // v95: 30 days is the default. An ID photo is only needed long enough to
  // answer a question about the decision; the usual practice is to keep
  // such documents for the shortest time that does the job. Files are
  // held longer automatically while a dispute or a fraud review involving
  // the account is open (see src/id-retention-scheduler.js).
  idDocumentRetentionDays: 30,

  // v78: the provider monthly plan fee. Off until the super admin switches
  // it on AND PLAN_BILLING_ENABLED=true is set on the server. See
  // src/plan-billing.js.
  planBilling: { on: false, startedAt: null, noticeDays: 30 },

  // The homepage's actual on-screen copy — hero headline/subheadline, the
  // rotating word in the hero, and the mission section. Editable in
  // Settings → Platform Settings without needing a code deploy. Kept
  // deliberately small (headline pieces + one paragraph) rather than a
  // full page-builder — the rest of the homepage (stats, categories,
  // trust badges) is generated from real data and isn't free-text anyway.
  homepageContent: {
    heroPrefix: "Local",
    heroRotatingWords: ['pros', 'plumbers', 'cleaners', 'tutors', 'electricians', 'painters'],
    heroSuffix: "you can check before you hire.",
    heroSubheadline: "Every pro on Trothen has had their government ID checked. You agree the price and the work in writing, and your payment is held until you mark the job done.",
    missionHeadline: "Hiring someone local shouldn't be a gamble.",
    missionBody: "Most people find a plumber or a tutor through a friend of a friend and hope it works out. If it doesn't, there's usually nobody to call. Trothen checks every pro's government ID before they can take a job, puts the price and the work in writing for every booking, and holds the payment until you say the job is done. If something goes wrong, our dispute team steps in.",
  },
};

// Front-page wording the super admin has changed from the built-in
// English (Admin → Settings → Front page wording). Empty = everything as
// shipped. Keys must be in EDITABLE_CONTENT_KEYS below.
DEFAULTS.contentOverrides = {};
const EDITABLE_CONTENT_KEYS = ["composer_what", "composer_where", "composer_go", "search_placeholder", "search_city_placeholder", "hero_often", "composer_hint", "chips_all", "chips_fewer", "ticket_title", "ticket_s1", "ticket_s2", "ticket_s3", "ticket_s4", "ticket_status_1", "ticket_status_2", "ticket_status_3", "ticket_status_4", "ticket_f_job", "ticket_f_pro", "ticket_f_terms", "ticket_f_pay", "ticket_f_status", "ticket_v_job", "ticket_v_pro", "ticket_v_terms", "ticket_v_pay", "ticket_v_status", "ticket_n1", "ticket_n2", "ticket_n3", "ticket_n4", "ticket_stamp", "ticket_next", "ticket_again", "ticket_post", "loc_live", "stat_pros", "stat_rating", "stat_jobs", "stat_fee", "checks_title", "checks_sub", "checks_tag", "checks_more", "checks_less", "check1_t", "check1_d", "check1_s1", "check1_s2", "check1_s3", "check2_t", "check2_d", "check2_s1", "check2_s2", "check2_s3", "check3_t", "check3_d", "check3_s1", "check3_s2", "check3_s3", "check3_note", "check4_t", "check4_d", "check4_s1", "check4_s2", "check4_s3", "checks_close", "popular_title", "popular_sub", "popular_from", "popular_pro_one", "popular_pro_many", "popular_see", "work_title", "work_sub", "cats_title", "cats_all", "cats_count_one", "cats_count_many", "cat_none", "cat_empty", "pro_one", "pro_many", "pros_title", "pros_sub", "pros_all", "reviews_title", "reviews_sub", "reviews_hired", "faq_title", "faq_sub", "faq_q1", "faq_a1", "faq_q2", "faq_a2", "faq_q3", "faq_a3", "faq_q4", "faq_a4", "faq_q5", "faq_a5", "faq_q6", "faq_a6", "cta_hire_t", "cta_hire_d", "cta_pro_t", "cta_pro_d", "nav_browse", "nav_become_pro", "nav_menu", "footer_line", "footer_about", "footer_careers", "footer_contact", "footer_terms", "trust_id", "trust_contract", "trust_payment", "trust_fraud", "trust_2fa", "qv_id_checked", "qv_new", "qv_jobs", "qv_from", "qv_per_hour", "qv_score", "qv_within", "qv_work", "qv_reviews", "qv_no_reviews", "qv_customer", "qv_not_taking", "qv_book", "qv_full", "qv_error", "plans_eyebrow", "plans_title", "plans_sub", "plans_country", "plan1_name", "plan1_desc", "plan1_f1", "plan1_f2", "plan1_f3", "plan1_f4", "plan1_f5", "plan2_name", "plan2_desc", "plan2_f1", "plan2_f2", "plan2_f3", "plan2_f4", "plan2_f5", "plan3_name", "plan3_desc", "plan3_f1", "plan3_f2", "plan3_f3", "plan3_f4", "plan3_f5", "plan4_name", "plan4_desc", "plan4_f1", "plan4_f2", "plan4_f3", "plan4_f4", "plan2_note", "plan3_note", "plan3_badge", "plan1_btn", "plan4_price", "plan4_btn", "plans_fee_off", "plans_fee_on", "careers_title", "careers_body", "careers_form_title", "careers_btn", "contact_title", "contact_intro", "contact_btn", "install_btn", "install_done", "install_ios_title", "install_ios_1", "install_ios_2", "install_ios_3", "install_ok"];

async function getSetting(key) {
  const row = await db.find('platformSettings', s => s.key === key);
  if (row) return row.value;
  return DEFAULTS[key];
}

async function setSetting(key, value) {
  const existing = await db.find('platformSettings', s => s.key === key);
  const patch = { key, value, updatedAt: new Date().toISOString() };
  if (existing) return db.update('platformSettings', existing.id, patch);
  return db.insert('platformSettings', { id: `ps_${key}`, ...patch });
}

// The actual per-booking calculation. Priority order, same fallback-chain
// convention used everywhere else in this app:
//   1. A category-level override (set in Categories & Countries) always
//      wins — e.g. "Emergency Plumbing" might always need a 30-minute
//      response regardless of how far out the job is.
//   2. Otherwise, the tiered default based on how soon the job actually
//      starts (see bookingResponseTiers above).
//   3. Hard floor either way: the deadline can never exceed the job's own
//      start time (confirming a job after it was supposed to start is
//      meaningless) and never drops below 15 minutes (so a same-hour
//      emergency booking still gets a real, if short, window instead of
//      an instantly-expired one).
function computeResponseWindowHours({ now, jobDateTime, tiers, categoryOverrideHours }) {
  let hours;
  if (categoryOverrideHours != null) {
    hours = categoryOverrideHours;
  } else if (jobDateTime && !isNaN(jobDateTime.getTime())) {
    const hoursUntilJob = (jobDateTime - now) / (1000 * 60 * 60);
    if (hoursUntilJob <= 24) hours = tiers.within24h;
    else if (hoursUntilJob <= 24 * 7) hours = tiers.within7d;
    else hours = tiers.beyond7d;
  } else {
    // Job date/time didn't parse (free-text edge case) — fall back to the
    // middle tier rather than guessing wrong in either direction.
    hours = tiers.within7d;
  }

  if (jobDateTime && !isNaN(jobDateTime.getTime())) {
    const hoursUntilJob = (jobDateTime - now) / (1000 * 60 * 60);
    const maxAllowed = Math.max(0.25, hoursUntilJob); // never past the job's own start time; floor of 15 minutes
    hours = Math.min(hours, maxAllowed);
  }
  return Math.round(hours * 100) / 100;
}

// v95: ONE support email for everything a visitor reads: the footer, the
// Terms of Service, the Privacy Policy, PDFs and the support chat. It is
// the address in Admin → Settings → Footer. (Before this, the footer read
// that setting, the Privacy Policy read a different one, and the Terms,
// PDFs and chat each had an address typed into the code.)
// If the footer address is blank, the support-contact email is used.
let supportEmailCache = '';
async function publicSupportEmail() {
  const footer = (await getSetting('footerInfo')) || {};
  const contact = (await getSetting('supportContact')) || {};
  supportEmailCache = String(footer.supportEmail || '').trim() || String(contact.email || '').trim();
  return supportEmailCache;
}
// For code that can't wait (PDF page footers). Kept fresh by the function above.
function supportEmailCached() { return supportEmailCache; }
// Advice shown to the super admin about the address, never to visitors.
function supportEmailAdvice(email, siteHost) {
  const notes = [];
  const e = String(email || '').trim().toLowerCase();
  if (!e) { notes.push({ level: 'problem', text: 'No support email is set. The Privacy Policy and Terms tell people to use the Contact Us page instead.' }); return notes; }
  const domain = e.split('@')[1] || '';
  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  if (/^(gmail|yahoo|ymail|outlook|hotmail|live|icloud|aol|proton|protonmail)\./.test(domain)) {
    notes.push({ level: 'advice', text: 'This is a personal-style mailbox. A business address on your own domain (for example support@' + (host && !/localhost|onrender/.test(host) ? host : 'yourdomain.com') + ') looks more trustworthy and is less likely to be treated as spam.' });
  } else if (host && !/localhost|onrender\.com$|^\d+\.\d+\.\d+\.\d+$/.test(host) && domain !== host && !host.endsWith('.' + domain) && !domain.endsWith('.' + host)) {
    notes.push({ level: 'problem', text: 'This address is on ' + domain + ', but the site is ' + host + '. Check that this mailbox really exists and that someone reads it. If it bounces, nobody can reach you about their data.' });
  }
  if (/^(no-?reply|donotreply|do-not-reply)@/.test(e)) notes.push({ level: 'problem', text: 'A no-reply address can\'t be used here. People must be able to write to it.' });
  return notes;
}

module.exports = { getSetting, setSetting, computeResponseWindowHours, DEFAULTS, EDITABLE_CONTENT_KEYS, publicSupportEmail, supportEmailCached, supportEmailAdvice };
