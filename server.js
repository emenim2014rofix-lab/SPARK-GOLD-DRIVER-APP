require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const { OAuth2Client } = require('google-auth-library');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);
const nodemailer = require('nodemailer');

const app = express();

// Email setup for support alerts (Updated for Hostinger SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SUPPORT_SMTP_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.SUPPORT_SMTP_PORT || '465'),
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.SUPPORT_EMAIL,
    pass: process.env.SUPPORT_EMAIL_PASSWORD
  }
});

// Log every single request so we can see it in Render Logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

let accounts = {};
let devices = {};
let supportThreads = {}; // userId -> [messages]
let referralAttributions = {}; // token -> { referrerId, ip, ua, code, status, createdAt }

// --- Referral Fingerprinting Helper ---
function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

// --- Support System ---
const AI_KNOWLEDGE = {
  "auto-accept": "Auto-accept automatically grabs orders that match your Smart Filters. You can set an 'Accept Delay' to make it look more human.",
  "mileage": "Mileage tracking uses high-accuracy GPS to log every mile you drive today. It resets daily at 11 PM and saves a summary to your history.",
  "filters": "Smart Filters allow you to set minimum price, maximum stops, and maximum miles. Only orders meeting these rules will be accepted.",
  "trial": "The free trial gives you 10 automated order accepts. After that, you'll need a Premium membership to continue using automation.",
  "membership": "Premium membership costs $29.99/month and includes unlimited order grabbing, full mileage tracking, and priority support.",
  "scanning": "Scanning uses an overlay bubble to watch your screen for orders. Make sure the Spark Gold Driver accessibility service is ON.",
  "stores": "Preferred Stores let you white-list specific locations. If enabled, the app will ignore orders from any other stores.",
  "hello": "Hello! I am the Spark Gold AI. I can help you with auto-accept, mileage tracking, filters, or membership questions. How can I help?",
  "help": "I can answer questions about: Auto-accept, Mileage, Smart Filters, Trial/Membership, Scanning, and Acceptance. Just ask!",
  "acceptance": "The 'Hands': Human-Like Acceptance. If an order passes all the checks, the app performs a Stealth Click: 1) Gaussian Delay (400ms to 700ms) to mimic a fast human reaction. 2) Randomized Coordinates: It picks a random pixel inside the button to avoid bot detection. 3) Sound Alert: If enabled, it plays a 'Success' sound.",
  "hands": "The 'Hands': Human-Like Acceptance. If an order passes all the checks, the app performs a Stealth Click: 1) Gaussian Delay (400ms to 700ms) to mimic a fast human reaction. 2) Randomized Coordinates: It picks a random pixel inside the button to avoid bot detection. 3) Sound Alert: If enabled, it plays a 'Success' sound."
};

function getAIResponse(userText) {
  const text = userText.toLowerCase();
  for (const key in AI_KNOWLEDGE) {
    if (text.includes(key)) return AI_KNOWLEDGE[key];
  }
  return "I'm not sure about that. A human support agent will also review your message and get back to you soon!";
}

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  res.json({ received: true });
});

app.use(bodyParser.json());

app.get('/', (req, res) => res.send('Driver Backend is ONLINE ✅'));

// --- New Referral Landing & Fingerprinting ---
app.get('/ref/:code', (req, res) => {
  const { code } = req.params;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'];

  console.log(`Referral landing: Code=${code}, IP=${ip}`);

  // 1. Find the referrer by code
  let referrerId = null;
  for (const uid in accounts) {
    if (accounts[uid].referralStats && accounts[uid].referralStats.code === code) {
      referrerId = uid;
      break;
    }
  }

  // 2. Create attribution token even if referrer not found (for tracking)
  const token = generateToken();
  referralAttributions[token] = {
    referrerId,
    code,
    ip,
    ua,
    status: 'pending',
    createdAt: Date.now()
  };

  // 3. Serve a simple landing page that starts download
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0A1930; color: white;">
        <h1>Spark Gold Driver</h1>
        <p>You've been invited! Your download will start automatically.</p>
        <p>Referral Code: <b>${code}</b></p>
        <a href="/download" style="color: #2DD4BF; font-weight: bold; text-decoration: none; border: 1px solid #2DD4BF; padding: 10px 20px; border-radius: 8px;">Download APK Manually</a>
        <script>
          // Automatic redirect to download after 2 seconds
          setTimeout(() => { window.location.href = "/download"; }, 2000);
        </script>
      </body>
    </html>
  `);
});

app.get('/download', (req, res) => {
  // In production, this would serve the real APK file
  res.send("APK Download would start here...");
});

// --- Android First Launch Resolution ---
app.post('/api/referral/resolve', (req, res) => {
  const { deviceId } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ua = req.headers['user-agent'];

  console.log(`Resolving attribution for Device=${deviceId}, IP=${ip}`);

  // Find recent pending attribution with matching IP and UA (within 1 hour)
  const oneHour = 60 * 60 * 1000;
  let matchedToken = null;

  for (const token in referralAttributions) {
    val = referralAttributions[token];
    if (val.status === 'pending' &&
        val.ip === ip &&
        val.ua === ua &&
        (Date.now() - val.createdAt) < oneHour) {
      matchedToken = token;
      break;
    }
  }

  if (matchedToken) {
    res.json({ success: true, attributionToken: matchedToken, code: referralAttributions[matchedToken].code });
  } else {
    res.json({ success: false, error: 'No matching attribution found' });
  }
});

// --- Support System ---
app.get('/support/messages', (req, res) => {
  const { userId } = req.query;
  res.json({ messages: supportThreads[userId] || [] });
});

app.post('/support/messages', async (req, res) => {
  const { userId, text, isBotResponse, route } = req.body;
  if (!supportThreads[userId]) supportThreads[userId] = [];

  // 1. Save Message (could be User or Bot)
  const msg = { text, fromUser: !isBotResponse, ts: Date.now() };
  if (route) msg.route = route;
  supportThreads[userId].push(msg);

  // 2. If it's a User message, check if we need to notify admin
  if (!isBotResponse) {
    const isTopic = Object.keys(AI_KNOWLEDGE).some(k => text.toLowerCase().includes(k.toLowerCase()));

    if (!isTopic) {
      const mailOptions = {
        from: process.env.SUPPORT_EMAIL,
        to: process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL,
        subject: `[Support Alert] New Question from ${userId}`,
        text: `User ID: ${userId}\nMessage: "${text}"\n\nPlease reply manually via the dashboard.`
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) console.error('[Email Error]', error);
        else console.log('[Email Sent] Manual reply required alert delivered');
      });
    }
  }

  res.json({ success: true });
});

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
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  // Mock data: In a real app, this would be stored in a database
  const safeId = (userId || "RAND").substring(0, 4).toUpperCase();
  const stats = (accounts[userId] && accounts[userId].referralStats) ? accounts[userId].referralStats : {
    code: 'REF' + safeId,
    referrals: 0,
    daysEarned: 0,
    bonusExpiryMillis: 0
  };
  res.json(stats);
});

app.post('/referral/redeem', (req, res) => {
  const { userId, code } = req.body;
  console.log(`Redeem attempt: User ${userId} with code ${code}`);

  if (!userId || !code) return res.status(400).json({ error: 'Missing userId or code' });

  // For testing: allow any code that starts with 'REF' OR any code if it's 'TEST123'
  if ((code.startsWith('REF') && code.length > 4) || code === 'TEST123') {
    // Mock success: grant 2 days from now
    const twoDaysMillis = 2 * 24 * 60 * 60 * 1000;
    const expiry = Date.now() + twoDaysMillis;

    if (!accounts[userId]) accounts[userId] = {};
    if (!accounts[userId].referralStats) {
        const safeId = (userId || "RAND").substring(0, 4).toUpperCase();
        accounts[userId].referralStats = {
            code: 'REF' + safeId,
            referrals: 0,
            daysEarned: 0,
            bonusExpiryMillis: 0
        };
    }
    accounts[userId].referralStats.bonusExpiryMillis = expiry;

    res.json({ success: true, bonusExpiryMillis: expiry });
  } else {
    res.status(400).json({ error: 'Invalid referral code (must start with REF)' });
  }
});

// --- Admin Support Dashboard ---
app.get('/admin/support', (req, res) => {
  const threads = Object.keys(supportThreads).map(userId => {
    const msgs = supportThreads[userId];
    return {
      userId,
      lastMessage: msgs[msgs.length - 1].text,
      count: msgs.length,
      lastTs: msgs[msgs.length - 1].ts
    };
  }).sort((a, b) => b.lastTs - a.lastTs);

  res.send(`
    <html>
      <head>
        <title>Support Admin</title>
        <style>
          body { font-family: sans-serif; background: #0A1930; color: white; padding: 20px; }
          .thread { background: #132A4D; padding: 15px; margin-bottom: 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
          .thread:hover { border-color: #2DD4BF; }
          .userId { font-weight: bold; color: #2DD4BF; }
          .msg { font-size: 0.9em; color: #8CA0BE; margin-top: 5px; }
          #chat { display: none; background: #132A4D; padding: 20px; border-radius: 12px; height: 80vh; flex-direction: column; }
          #messages { flex: 1; overflow-y: auto; margin-bottom: 20px; padding: 10px; }
          .bubble { margin-bottom: 10px; padding: 10px; border-radius: 12px; max-width: 70%; }
          .user { background: #F5A623; color: #0A1930; align-self: flex-start; }
          .admin { background: #2DD4BF; color: #0A1930; align-self: flex-end; margin-left: auto; }
          input { background: #0A1930; border: 1px solid #8CA0BE; color: white; padding: 10px; border-radius: 8px; width: 80%; }
          button { background: #2DD4BF; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; }
        </style>
      </head>
      <body>
        <h1>Support Inbox</h1>
        <div id="list">
          ${threads.map(t => `
            <div class="thread" onclick="openThread('${t.userId}')">
              <div class="userId">${t.userId}</div>
              <div class="msg">${t.lastMessage}</div>
            </div>
          `).join('')}
        </div>
        <div id="chat">
          <button onclick="back()">← Back</button>
          <h2 id="chatTitle"></h2>
          <div id="messages"></div>
          <div style="display: flex; gap: 10px;">
            <input type="text" id="replyInput" placeholder="Type reply...">
            <button onclick="sendReply()">Send</button>
          </div>
        </div>
        <script>
          let currentUserId = null;
          async function openThread(userId) {
            currentUserId = userId;
            document.getElementById('list').style.display = 'none';
            document.getElementById('chat').style.display = 'flex';
            document.getElementById('chatTitle').innerText = 'Chat with ' + userId;
            refreshMessages();
          }
          async function refreshMessages() {
            if (!currentUserId) return;
            const res = await fetch('/support/messages?userId=' + currentUserId);
            const data = await res.json();
            const container = document.getElementById('messages');
            container.innerHTML = data.messages.map(m => \`
              <div class="bubble \${m.fromUser ? 'user' : 'admin'}">\${m.text}</div>
            \`).join('');
            container.scrollTop = container.scrollHeight;
          }
          async function sendReply() {
            const text = document.getElementById('replyInput').value;
            if (!text) return;
            await fetch('/support/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: currentUserId, text, isBotResponse: true })
            });
            document.getElementById('replyInput').value = '';
            refreshMessages();
          }
          function back() {
            currentUserId = null;
            document.getElementById('list').style.display = 'block';
            document.getElementById('chat').style.display = 'none';
            location.reload();
          }
        </script>
      </body>
    </html>
  `);
});

// Use the PORT Render gives us, or default to 10000
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => console.log(`Backend live on port ${port}`));
