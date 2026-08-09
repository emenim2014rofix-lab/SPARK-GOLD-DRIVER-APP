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

// Path configuration moved to TOP to prevent ReferenceErrors
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const THREADS_FILE = path.join(DATA_DIR, 'support-threads.json');
const REFERRAL_FILE = path.join(DATA_DIR, 'referrals.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

/**
 * Persistence Helpers
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, defaultVal = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return defaultVal;
  }
}

function saveJson(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save ${file}:`, err.message);
  }
}

// Global Stores (In-memory + File Sync)
const accounts = loadJson(ACCOUNTS_FILE); // userId -> { email, stripeCustomerId, trialUsed }
const devices = loadJson(DEVICES_FILE);   // deviceId -> { trialUsed }
const supportThreads = loadJson(THREADS_FILE);
const referralStore = loadJson(REFERRAL_FILE, { users: {}, codes: {} });

/**
 * Stripe Webhook
 */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const sub = event.data.object;
  // Note: For simplicity in this local-file version, Stripe status is usually
  // fetched live or stored in the accounts.json.
  res.json({ received: true });
});

app.use(bodyParser.json());

/**
 * Authentication & Identity
 */
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_WEB_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const userId = payload.sub;
    const email = payload.email;

    if (!accounts[userId]) {
      accounts[userId] = { email, stripeCustomerId: null, trialUsed: 0 };
    } else {
      accounts[userId].email = email;
    }
    saveJson(ACCOUNTS_FILE, accounts);

    res.json({ userId, email, stripeCustomerId: accounts[userId].stripeCustomerId });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * Membership & Trial Logic
 */
app.get('/membership-status', async (req, res) => {
  const { customerId, uid, deviceId } = req.query;
  const TRIAL_LIMIT = 10;

  let active = false;
  let currentPeriodEnd = 0;
  let cancelAtPeriodEnd = false;

  // 1. Check Stripe if customerId exists
  if (customerId && customerId !== 'null') {
    try {
      const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
      if (subscriptions.data.length > 0) {
        const sub = subscriptions.data[0];
        active = sub.status === 'active' || sub.status === 'trialing';
        currentPeriodEnd = sub.current_period_end;
        cancelAtPeriodEnd = sub.cancel_at_period_end;
      }
    } catch (e) {}
  }

  // 2. Calculate Trial Usage (Email-based or Device-based)
  const userTrial = (uid && accounts[uid]) ? (accounts[uid].trialUsed || 0) : 0;
  const deviceTrial = (deviceId && devices[deviceId]) ? (devices[deviceId].trialUsed || 0) : 0;

  // Use the highest count to prevent bypass
  const trialUsed = Math.max(userTrial, deviceTrial);

  res.json({
    active,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    trialUsed,
    trialLimit: TRIAL_LIMIT
  });
});

/**
 * Increment Trial Count
 */
app.post('/order-accepted', (req, res) => {
  const { uid, deviceId } = req.body;

  if (uid && accounts[uid]) {
    accounts[uid].trialUsed = (accounts[uid].trialUsed || 0) + 1;
    saveJson(ACCOUNTS_FILE, accounts);
  }

  if (deviceId) {
    if (!devices[deviceId]) devices[deviceId] = { trialUsed: 0 };
    devices[deviceId].trialUsed += 1;
    saveJson(DEVICES_FILE, devices);
  }

  res.json({ success: true });
});

/**
 * Referral System
 */
app.get('/referral/me', (req, res) => {
  const { userId } = req.query;
  if (!userId || !accounts[userId]) return res.status(400).json({ error: 'Valid userId required' });

  if (!referralStore.users[userId]) {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    referralStore.users[userId] = { code, referrals: 0, daysEarned: 0, bonusExpiryMillis: 0 };
    referralStore.codes[code] = userId;
    saveJson(REFERRAL_FILE, referralStore);
  }
  res.json(referralStore.users[userId]);
});

app.post('/referral/redeem', (req, res) => {
  const { userId, code } = req.body;
  const normalizedCode = String(code).trim().toUpperCase();
  const ownerId = referralStore.codes[normalizedCode];

  if (!ownerId || ownerId === userId) return res.status(400).json({ error: 'Invalid code' });

  const now = Date.now();
  const BONUS = 2 * 24 * 60 * 60 * 1000;

  // Reward redeemer
  if (!referralStore.users[userId]) referralStore.users[userId] = { referrals: 0, daysEarned: 0, bonusExpiryMillis: 0 };
  referralStore.users[userId].bonusExpiryMillis = Math.max(now, referralStore.users[userId].bonusExpiryMillis) + BONUS;

  // Reward owner
  referralStore.users[ownerId].referrals += 1;
  referralStore.users[ownerId].daysEarned += 2;
  referralStore.users[ownerId].bonusExpiryMillis = Math.max(now, referralStore.users[ownerId].bonusExpiryMillis) + BONUS;

  saveJson(REFERRAL_FILE, referralStore);
  res.json({ success: true, bonusExpiryMillis: referralStore.users[userId].bonusExpiryMillis });
});

/**
 * Support System
 */
app.post('/support/messages', (req, res) => {
  const { userId, text } = req.body;
  if (!supportThreads[userId]) supportThreads[userId] = [];
  supportThreads[userId].push({ text, fromUser: true, ts: Date.now() });
  saveJson(THREADS_FILE, supportThreads);
  res.json({ success: true });
});

app.get('/support/messages', (req, res) => {
  res.json({ messages: supportThreads[req.query.userId] || [] });
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`Driver App Backend running on port ${port}`));
