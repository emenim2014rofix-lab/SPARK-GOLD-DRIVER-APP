require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const { OAuth2Client } = require('google-auth-library');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);

// Safe-load nodemailer to prevent crash if not installed on server
let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('[Warning] nodemailer module not found. Email alerts disabled.');
}

const app = express();

// Email setup (Hostinger SMTP)
let transporter = null;
if (nodemailer && process.env.SUPPORT_EMAIL) {
  transporter = nodemailer.createTransport({
    host: process.env.SUPPORT_SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SUPPORT_SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SUPPORT_EMAIL,
      pass: process.env.SUPPORT_EMAIL_PASSWORD
    }
  });
}

// Log requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

let accounts = {};
let devices = {};
let supportThreads = {}; // userId -> [messages]
let referralAttributions = {};

function generateToken() { return require('crypto').randomBytes(32).toString('hex'); }

const AI_KNOWLEDGE = {
  "auto-accept": "Auto-accept automatically grabs orders that match your Smart Filters.",
  "mileage": "Mileage tracking uses GPS to log every mile. Resets at 11 PM.",
  "filters": "Smart Filters allow you to set minimum price, stops, and miles.",
  "trial": "Free trial gives 10 automated order accepts.",
  "membership": "Premium membership costs $29.99/month.",
  "hello": "Hello! I am the Spark Gold AI. How can I help?",
  "help": "I can answer about: Auto-accept, Mileage, Filters, and Membership."
};

// Persistent storage for premium users
let premiumUsers = {}; // firebaseUid -> { active: true, expiry: ts }

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  console.log(`[Webhook] Received request from Stripe. Signature present: ${!!sig}`);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[Webhook Error] Verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Webhook] Event verified: ${event.type}`);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const firebaseUid = session.client_reference_id;
    console.log(`[Webhook] Session completed. UID found: ${firebaseUid}`);

    if (firebaseUid) {
      console.log(`[Payment Success] Unlocking premium for: ${firebaseUid}`);
      premiumUsers[firebaseUid] = { active: true, expiry: Date.now() + (30 * 24 * 60 * 60 * 1000) };
    } else {
      console.warn(`[Webhook Warning] Payment succeeded but no client_reference_id (UID) was found!`);
    }
  }
  res.json({ received: true });
});

app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Driver Backend is ONLINE (v4 - Production Stable) ✅'));

// Support Endpoints
app.get('/support/messages', (req, res) => {
  const { userId } = req.query;
  res.json({ messages: supportThreads[userId] || [] });
});

app.post('/support/messages', async (req, res) => {
  const { userId, text, isBotResponse, route } = req.body;
  if (!supportThreads[userId]) supportThreads[userId] = [];
  const msg = { text, fromUser: !isBotResponse, ts: Date.now() };
  if (route) msg.route = route;
  supportThreads[userId].push(msg);

  // Send Email Alert if it's a new human message and transporter is ready
  if (!isBotResponse && transporter) {
    const isTopic = Object.keys(AI_KNOWLEDGE).some(k => text.toLowerCase().includes(k.toLowerCase()));
    if (!isTopic) {
      transporter.sendMail({
        from: process.env.SUPPORT_EMAIL,
        to: process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL,
        subject: `[Support] New Message from ${userId}`,
        text: `Message: "${text}"\nReply at: /admin/support`
      }).catch(err => console.error('[Email Error]', err));
    }
  }
  res.json({ success: true });
});

// Membership & Billing
app.get('/membership-status', async (req, res) => {
  const { customerId, uid, deviceId, email } = req.query;
  const TRIAL_LIMIT = 10;
  let active = false;
  let currentPeriodEnd = Math.floor(Date.now() / 1000);

  // 1. Check if user is in our Webhook success list
  if (uid && premiumUsers[uid]) {
    active = true;
    currentPeriodEnd = Math.floor(premiumUsers[uid].expiry / 1000);
  }

  // 2. Original checks (Stripe Search)
  if (!active) {
    try {
      if (customerId && customerId !== 'null' && customerId !== '') {
        const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
        active = subscriptions.data.some(s => s.status === 'active' || s.status === 'trialing');
        if (active) currentPeriodEnd = subscriptions.data[0].current_period_end;
      }
      if (!active && email && email !== 'null' && email !== '') {
        const customers = await stripe.customers.list({ email: email, limit: 1 });
        if (customers.data.length > 0) {
          const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, limit: 1 });
          active = subs.data.some(s => s.status === 'active' || s.status === 'trialing');
          if (active) currentPeriodEnd = subs.data[0].current_period_end;
        }
      }
    } catch (e) { console.error('Stripe Security Check Error:', e.message); }
  }

  const userTrial = (uid && accounts[uid]) ? (accounts[uid].trialUsed || 0) : 0;
  const deviceTrial = (deviceId && devices[deviceId]) ? (devices[deviceId].trialUsed || 0) : 0;

  res.json({
    active,
    trialUsed: Math.max(userTrial, deviceTrial),
    trialLimit: TRIAL_LIMIT,
    currentPeriodEnd: currentPeriodEnd
  });
});

app.post('/create-subscription', async (req, res) => {
  try {
    const customer = await stripe.customers.create({ email: req.body.email });
    const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customer.id }, { apiVersion: '2023-10-16' });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
    res.json({ clientSecret: subscription.latest_invoice.payment_intent.client_secret, customerId: customer.id, ephemeralKey: ephemeralKey.secret, subscriptionId: subscription.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Admin Support Dashboard
app.get('/admin/support', (req, res) => {
  const threads = Object.keys(supportThreads).map(userId => ({
    userId, lastMessage: supportThreads[userId][supportThreads[userId].length - 1].text, ts: supportThreads[userId][supportThreads[userId].length - 1].ts
  })).sort((a, b) => b.ts - a.ts);

  res.send(`
    <html>
      <head><title>Support Admin</title><style>
        body { font-family: sans-serif; background: #0A1930; color: white; padding: 20px; }
        .thread { background: #132A4D; padding: 15px; margin-bottom: 10px; border-radius: 8px; cursor: pointer; }
        .thread:hover { border-color: #2DD4BF; border: 1px solid #2DD4BF; }
        #chat { display: none; background: #132A4D; padding: 20px; border-radius: 12px; height: 80vh; flex-direction: column; }
        #messages { flex: 1; overflow-y: auto; margin-bottom: 20px; display: flex; flex-direction: column; }
        .bubble { margin-bottom: 10px; padding: 10px; border-radius: 12px; max-width: 70%; }
        .user { background: #F5A623; color: #0A1930; align-self: flex-start; }
        .admin { background: #2DD4BF; color: #0A1930; align-self: flex-end; }
        input { background: #0A1930; border: 1px solid #8CA0BE; color: white; padding: 10px; border-radius: 8px; width: 70%; }
        button { background: #2DD4BF; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; }
      </style></head>
      <body>
        <h1>Support Inbox</h1>
        <div id="list">${threads.map(t => `<div class="thread" onclick="openThread('${t.userId}')"><b>${t.userId}</b><br>${t.lastMessage}</div>`).join('')}</div>
        <div id="chat">
          <button onclick="location.reload()">← Back</button><h2 id="title"></h2>
          <div id="messages"></div>
          <div style="display:flex; gap:10px;"><input type="text" id="input"><button onclick="send()">Send</button></div>
        </div>
        <script>
          let curId = null;
          async function openThread(id) {
            curId = id; document.getElementById('list').style.display = 'none'; document.getElementById('chat').style.display = 'flex';
            document.getElementById('title').innerText = id; refresh();
          }
          async function refresh() {
            const res = await fetch('/support/messages?userId=' + curId);
            const data = await res.json();
            document.getElementById('messages').innerHTML = data.messages.map(m => \`<div class="bubble \${m.fromUser ? 'user' : 'admin'}">\${m.text}</div>\`).join('');
          }
          async function send() {
            const text = document.getElementById('input').value;
            await fetch('/support/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: curId, text, isBotResponse: true }) });
            document.getElementById('input').value = ''; refresh();
          }
        </script>
      </body>
    </html>
  `);
});

const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => console.log('Server live on ' + port));
