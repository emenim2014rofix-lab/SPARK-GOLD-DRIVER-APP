require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const { OAuth2Client } = require('google-auth-library');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);
const app = express();

// Log every single request so we can see it in Render Logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

let accounts = {};
let devices = {};

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  res.json({ received: true });
});

app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Driver Backend is ONLINE ✅'));

app.get('/membership-status', async (req, res) => {
  const { customerId, uid, deviceId } = req.query;
  const TRIAL_LIMIT = 10;
  let active = false;
  if (customerId && customerId !== 'null') {
    try {
      const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
      active = subscriptions.data.some(s => s.status === 'active' || s.status === 'trialing');
    } catch (e) { console.error('Stripe Status Error:', e.message); }
  }
  const userTrial = (uid && accounts[uid]) ? (accounts[uid].trialUsed || 0) : 0;
  const deviceTrial = (deviceId && devices[deviceId]) ? (devices[deviceId].trialUsed || 0) : 0;
  res.json({ active, trialUsed: Math.max(userTrial, deviceTrial), trialLimit: TRIAL_LIMIT });
});

app.post('/create-subscription', async (req, res) => {
  console.log('Checkout requested for:', req.body.email);
  try {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
    if (!process.env.STRIPE_PRICE_ID) throw new Error('Missing STRIPE_PRICE_ID');

    const customer = await stripe.customers.create({ email: req.body.email });
    const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customer.id }, { apiVersion: '2023-10-16' });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      customerId: customer.id,
      ephemeralKey: ephemeralKey.secret,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    console.error('Checkout Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/order-accepted', (req, res) => {
  const { uid, deviceId } = req.body;
  if (uid && accounts[uid]) accounts[uid].trialUsed = (accounts[uid].trialUsed || 0) + 1;
  if (deviceId) {
    if (!devices[deviceId]) devices[deviceId] = { trialUsed: 0 };
    devices[deviceId].trialUsed += 1;
  }
  res.json({ success: true });
});

app.get('/referral/me', (req, res) => {
  res.json({ code: 'REF' + Math.floor(Math.random()*1000), referrals: 0, daysEarned: 0 });
});

// Use the PORT Render gives us, or default to 10000
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => console.log(`Backend live on port ${port}`));
