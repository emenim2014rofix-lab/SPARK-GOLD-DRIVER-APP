// Minimal backend for the Driver App's monthly membership.
// This is the ONLY place your Stripe secret key is ever used.
// The Android app never sees it - it only talks to these HTTP endpoints.

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);
const app = express();

// In-memory store for demo purposes: customerId -> membership info.
// Replace this with a real database (Postgres, SQLite, Firestore, etc.)
// before shipping to real users - this resets every time the server restarts.
const membershipStore = new Map();

/**
 * IMPORTANT: the webhook route needs the *raw* body (not JSON-parsed) to verify
 * Stripe's signature, so it's registered BEFORE the global express.json() middleware.
 */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sub = event.data.object;

  switch (event.type) {
    // Payment succeeded (first payment, or a renewal) -> membership is active.
    case 'invoice.payment_succeeded': {
      const customerId = sub.customer;
      const subscriptionId = sub.subscription;
      stripe.subscriptions.retrieve(subscriptionId).then((subscription) => {
        membershipStore.set(customerId, {
          active: true,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          subscriptionId,
        });
      });
      break;
    }

    // Payment failed (e.g. card declined on renewal) -> lock the app out.
    case 'invoice.payment_failed': {
      const customerId = sub.customer;
      const existing = membershipStore.get(customerId) || {};
      membershipStore.set(customerId, { ...existing, active: false });
      break;
    }

    // Subscription fully canceled/ended -> lock the app out.
    case 'customer.subscription.deleted': {
      const customerId = sub.customer;
      const existing = membershipStore.get(customerId) || {};
      membershipStore.set(customerId, { ...existing, active: false, currentPeriodEnd: sub.current_period_end });
      break;
    }

    // Auto-renew toggled from Stripe's side (rare, but keep in sync).
    case 'customer.subscription.updated': {
      const customerId = sub.customer;
      const existing = membershipStore.get(customerId) || {};
      membershipStore.set(customerId, {
        ...existing,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      });
      break;
    }
  }

  res.json({ received: true });
});

app.use(bodyParser.json());

/**
 * Real, on-demand nearby gas station prices — called only when the driver
 * taps "Find gas prices" in the app (there's no background polling for this,
 * to keep it battery-friendly). Uses the Google Places API (New) Nearby
 * Search, which returns real station-reported fuel prices via the
 * `fuelOptions` field for supported regions (falls back to an empty price
 * list for a station if that data isn't available there).
 */
app.get('/gas-prices', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng query params are required' });
    }

    const placesRes = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.fuelOptions',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station'],
        maxResultCount: 10,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: 8046.72, // 5 miles, in meters — Places API requires meters
          },
        },
      }),
    });

    if (!placesRes.ok) {
      const errText = await placesRes.text();
      console.error('Places API error:', errText);
      return res.status(502).json({ error: 'Could not reach the gas station data provider' });
    }

    const data = await placesRes.json();
    const stations = (data.places || []).map((place) => ({
      id: place.id,
      name: place.displayName?.text || 'Gas station',
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      prices: (place.fuelOptions?.fuelPrices || []).map((fp) => ({
        type: fp.type,
        price: fp.price?.units != null
          ? Number(fp.price.units) + (fp.price.nanos || 0) / 1e9
          : null,
        currency: fp.price?.currencyCode || 'USD',
      })).filter((p) => p.price != null),
    }));

    res.json({ stations });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * Real accounts via "Sign in with Google" — this is what lets membership
 * (and referral/support history) survive a reinstall or a new phone: instead
 * of a random per-install ID, the app authenticates as a real Google account,
 * and that stable Google user ID (payload.sub) is the key everything else
 * hangs off of.
 *
 * The Android app never verifies the ID token itself — it just gets one from
 * Credential Manager and hands it to this endpoint. Verification MUST happen
 * here, server-side, with your real secret-holding backend, or anyone could
 * fake being logged in as anyone else.
 */
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function loadAccounts() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))));
  } catch (err) {
    return new Map();
  }
}

function saveAccounts(map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    console.error('Failed to persist accounts.json:', err.message);
  }
}

const accounts = loadAccounts();

app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID, // must match the Web Client ID used to request the token
    });
    const payload = ticket.getPayload();
    const userId = payload.sub; // stable per Google account — never changes, unlike email
    const email = payload.email;

    let account = accounts.get(userId);
    if (!account) {
      account = { email, stripeCustomerId: null };
      accounts.set(userId, account);
    } else {
      account.email = email; // keep it fresh in case they renamed/changed it
    }
    saveAccounts(accounts);

    res.json({ userId, email, stripeCustomerId: account.stripeCustomerId });
  } catch (err) {
    console.error('Google token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid Google sign-in token' });
  }
});

/**
 * Called when the app wants to start (or resume) a subscription.
 * Creates a Stripe Customer + Subscription in "incomplete" status and returns
 * everything the app's PaymentSheet needs to collect a card and confirm it.
 */
app.post('/create-subscription', async (req, res) => {
  try {
    const { email, googleUserId } = req.body;

    const customer = await stripe.customers.create({ email });

    // Ties this Stripe customer to the signed-in Google account, so
    // /auth/google returns it again on any device this person signs into.
    if (googleUserId) {
      const account = accounts.get(googleUserId);
      if (account) {
        account.stripeCustomerId = customer.id;
        saveAccounts(accounts);
      }
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2023-10-16' }
    );

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    membershipStore.set(customer.id, {
      active: false, // becomes true once the webhook confirms payment
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: false,
      subscriptionId: subscription.id,
    });

    res.json({
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * The app polls this after checkout (and on every launch) to know whether
 * to show the app or the paywall.
 */
app.get('/membership-status', (req, res) => {
  const { customerId } = req.query;
  const record = membershipStore.get(customerId);
  if (!record) {
    return res.json({ active: false, currentPeriodEnd: 0, cancelAtPeriodEnd: false });
  }
  res.json({
    active: !!record.active,
    currentPeriodEnd: record.currentPeriodEnd || 0,
    cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
  });
});

/**
 * Stops auto-renew. The membership stays active until the period already
 * paid for runs out, then it will not renew - matching "stop until it runs out".
 */
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message });
  }
});

/** Turns auto-renew back on before the current period ends. */
app.post('/resume-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, error: err.message });
  }
});

const port = process.env.PORT || 4242;

/**
 * Real support messaging — replaces the old fake in-app "bot". A driver's
 * message lands here and is stored per userId; a human (you) reads it and
 * replies from the /admin/support page below, and the app polls this same
 * thread so the reply shows up right in the conversation, no bot involved.
 *
 * Persisted to a JSON file on disk (data/support-threads.json) so messages
 * survive a normal server restart — no separate database needed for this
 * volume of data. NOTE: on hosts with an ephemeral filesystem (e.g. Render's
 * free tier wipes local disk on every redeploy, though not on a plain
 * restart), this file won't survive a redeploy — attach a persistent disk,
 * or swap this for a real database, before depending on long-term history.
 */
const DATA_DIR = path.join(__dirname, 'data');
const THREADS_FILE = path.join(DATA_DIR, 'support-threads.json');

function loadThreads() {
  try {
    const raw = fs.readFileSync(THREADS_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map(); // first run, or file doesn't exist yet — start empty
  }
}

function saveThreads(map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(THREADS_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    console.error('Failed to persist support-threads.json:', err.message);
  }
}

const supportThreads = loadThreads();

app.post('/support/messages', (req, res) => {
  const { userId, text } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId and text are required' });
  const thread = supportThreads.get(userId) || [];
  thread.push({ text, fromUser: true, ts: Date.now() });
  supportThreads.set(userId, thread);
  saveThreads(supportThreads);
  res.json({ success: true });
});

app.get('/support/messages', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  res.json({ messages: supportThreads.get(userId) || [] });
});

// Everything under /admin requires ?secret=... matching your ADMIN_SECRET env
// var, since this is the only thing standing between a stranger and every
// driver's support messages. Set a real ADMIN_SECRET in your .env file.
function requireAdmin(req, res, next) {
  if (req.query.secret !== process.env.ADMIN_SECRET || !process.env.ADMIN_SECRET) {
    return res.status(403).send('Forbidden — missing or wrong ?secret=');
  }
  next();
}

app.get('/admin/support/threads', requireAdmin, (req, res) => {
  const summaries = Array.from(supportThreads.entries()).map(([userId, msgs]) => ({
    userId,
    lastMessage: msgs[msgs.length - 1],
    count: msgs.length,
  }));
  res.json({ threads: summaries });
});

app.post('/admin/support/reply', requireAdmin, (req, res) => {
  const { userId, text } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId and text are required' });
  const thread = supportThreads.get(userId) || [];
  thread.push({ text, fromUser: false, ts: Date.now() });
  supportThreads.set(userId, thread);
  saveThreads(supportThreads);
  res.json({ success: true });
});

// A tiny, dependency-free admin page — open http://localhost:4242/admin/support?secret=YOUR_SECRET
app.get('/admin/support', requireAdmin, (req, res) => {
  const secret = req.query.secret;
  res.send(`<!DOCTYPE html><html><head><title>Support inbox</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#0E1620;color:#EDEFF2;margin:0;display:flex;height:100vh}
    #list{width:280px;overflow-y:auto;border-right:1px solid #2A3A48}
    .thread{padding:12px;border-bottom:1px solid #2A3A48;cursor:pointer}
    .thread:hover{background:#182430}
    #chat{flex:1;display:flex;flex-direction:column;padding:16px}
    #msgs{flex:1;overflow-y:auto}
    .msg{max-width:70%;margin:6px 0;padding:8px 12px;border-radius:10px}
    .user{background:#182430;align-self:flex-start}
    .me{background:#FFB100;color:#0E1620;margin-left:auto}
    #row{display:flex;gap:8px;margin-top:10px}
    input{flex:1;padding:10px;border-radius:8px;border:1px solid #2A3A48;background:#182430;color:#EDEFF2}
    button{padding:10px 16px;border-radius:8px;border:none;background:#00C2A8;color:#0E1620;font-weight:bold;cursor:pointer}
  </style></head><body>
  <div id="list"></div>
  <div id="chat"><div id="msgs" style="display:flex;flex-direction:column"></div>
    <div id="row"><input id="input" placeholder="Reply…"/><button onclick="send()">Send</button></div>
  </div>
  <script>
    const secret = ${JSON.stringify(secret)};
    let activeUser = null;
    async function loadThreads() {
      const r = await fetch('/admin/support/threads?secret=' + secret);
      const data = await r.json();
      const list = document.getElementById('list');
      list.innerHTML = data.threads.map(t =>
        '<div class="thread" onclick="openThread(\\'' + t.userId + '\\')"><b>' + t.userId.slice(0,8) + '…</b><br><small>' + (t.lastMessage?.text || '').slice(0,40) + '</small></div>'
      ).join('');
    }
    async function openThread(userId) {
      activeUser = userId;
      const r = await fetch('/support/messages?userId=' + userId);
      const data = await r.json();
      document.getElementById('msgs').innerHTML = data.messages.map(m =>
        '<div class="msg ' + (m.fromUser ? 'user' : 'me') + '">' + m.text + '</div>'
      ).join('');
    }
    async function send() {
      if (!activeUser) return;
      const input = document.getElementById('input');
      if (!input.value.trim()) return;
      await fetch('/admin/support/reply?secret=' + secret, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ userId: activeUser, text: input.value })
      });
      input.value = '';
      openThread(activeUser);
    }
    loadThreads();
    setInterval(loadThreads, 5000);
  </script></body></html>`);
});

/**
 * Real referral system. Each install gets its own unique code the first
 * time it asks for one. Redeeming someone else's code gives BOTH sides 2
 * free days of Premium access (tracked as bonusExpiryMillis, which the app
 * checks alongside the trial/membership status) — one redemption per
 * install, and you can't redeem your own code. Persisted to disk so it
 * survives a restart, same caveat as support-threads.json re: ephemeral
 * hosting filesystems (see README).
 */
const REFERRAL_FILE = path.join(DATA_DIR, 'referrals.json');
const BONUS_DAYS_MILLIS = 2 * 24 * 60 * 60 * 1000;

function loadReferrals() {
  try {
    const raw = fs.readFileSync(REFERRAL_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { users: new Map(Object.entries(parsed.users || {})), codes: new Map(Object.entries(parsed.codes || {})) };
  } catch (err) {
    return { users: new Map(), codes: new Map() }; // first run
  }
}

function saveReferrals(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REFERRAL_FILE, JSON.stringify({
      users: Object.fromEntries(store.users),
      codes: Object.fromEntries(store.codes),
    }));
  } catch (err) {
    console.error('Failed to persist referrals.json:', err.message);
  }
}

const referralStore = loadReferrals();

function generateUniqueCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (referralStore.codes.has(code));
  return code;
}

function getOrCreateReferralUser(userId) {
  let user = referralStore.users.get(userId);
  if (!user) {
    const code = generateUniqueCode();
    user = { code, referrals: 0, daysEarned: 0, bonusExpiryMillis: 0, redeemedCode: null };
    referralStore.users.set(userId, user);
    referralStore.codes.set(code, userId);
    saveReferrals(referralStore);
  }
  return user;
}

app.get('/referral/me', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const user = getOrCreateReferralUser(userId);
  res.json(user);
});

app.post('/referral/redeem', (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'userId and code are required' });

  const normalizedCode = String(code).trim().toUpperCase();
  const ownerId = referralStore.codes.get(normalizedCode);
  if (!ownerId) return res.status(404).json({ error: 'That code doesn\'t exist.' });
  if (ownerId === userId) return res.status(400).json({ error: 'You can\'t use your own code.' });

  const redeemer = getOrCreateReferralUser(userId);
  if (redeemer.redeemedCode) return res.status(400).json({ error: 'You already redeemed a referral code.' });

  const now = Date.now();
  redeemer.redeemedCode = normalizedCode;
  redeemer.bonusExpiryMillis = Math.max(now, redeemer.bonusExpiryMillis) + BONUS_DAYS_MILLIS;

  const owner = getOrCreateReferralUser(ownerId);
  owner.referrals += 1;
  owner.daysEarned += 2;
  owner.bonusExpiryMillis = Math.max(now, owner.bonusExpiryMillis) + BONUS_DAYS_MILLIS;

  saveReferrals(referralStore);
  res.json({ success: true, bonusExpiryMillis: redeemer.bonusExpiryMillis });
});

app.listen(port, () => console.log(`Driver App billing backend running on port ${port}`));
