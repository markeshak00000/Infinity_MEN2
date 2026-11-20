require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, 'data');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const FCM_TOKENS_FILE = path.join(DATA_DIR, 'fcm-tokens.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'firebase-service-account.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const allowedOrigins = (process.env.APP_ORIGINS || process.env.APP_ORIGIN || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Requests from native WebViews may provide the configured https://localhost origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['content-type', 'authorization'],
  maxAge: 600
}));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function writeJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function authorizeAdmin(req, res, next) {
  const expected = process.env.PUSH_API_KEY || '';
  const received = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (!expected || !received || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const vapidSubject = process.env.VAPID_SUBJECT || '';
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/i.test(vapidSubject)) {
  throw new Error('Set VAPID_SUBJECT in server/.env to a real mailto: address or HTTPS contact URL before starting the Push service.');
}
let vapid = readJson(VAPID_FILE, null);
if (!vapid || !vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  writeJson(VAPID_FILE, vapid);
  console.log('Generated VAPID keys and saved them in server/data/vapid.json');
}
webpush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);

let firebaseMessaging = null;
if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  try {
    const admin = require('firebase-admin');
    const serviceAccount = readJson(SERVICE_ACCOUNT_FILE, null);
    if (!serviceAccount || !serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      throw new Error('Firebase service account JSON is missing required fields.');
    }
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseMessaging = admin.messaging();
    console.log('Firebase Cloud Messaging is configured.');
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
  }
} else {
  console.log('Firebase Cloud Messaging is not configured; Web Push can still work.');
}

app.get('/api/push/health', (_req, res) => res.json({
  ok: true,
  service: 'Infinity MEN2 Push',
  webPush: true,
  firebaseConfigured: Boolean(firebaseMessaging)
}));
app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  const subscriptions = readJson(SUBSCRIPTIONS_FILE, []);
  const next = subscriptions.filter((item) => item.endpoint !== sub.endpoint);
  next.push({ ...sub, savedAt: new Date().toISOString() });
  writeJson(SUBSCRIPTIONS_FILE, next);
  res.status(201).json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Missing endpoint' });
  const subscriptions = readJson(SUBSCRIPTIONS_FILE, []).filter((item) => item.endpoint !== endpoint);
  writeJson(SUBSCRIPTIONS_FILE, subscriptions);
  res.json({ ok: true });
});

app.post('/api/fcm/register', (req, res) => {
  const token = req.body && req.body.token;
  const platform = req.body && req.body.platform;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    return res.status(400).json({ error: 'Invalid FCM token' });
  }
  if (!['android', 'ios'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
  const tokens = readJson(FCM_TOKENS_FILE, []);
  const next = tokens.filter((item) => item.token !== token);
  next.push({ token, platform, savedAt: new Date().toISOString() });
  writeJson(FCM_TOKENS_FILE, next);
  res.status(201).json({ ok: true });
});

app.post('/api/fcm/unregister', (req, res) => {
  const token = req.body && req.body.token;
  if (typeof token !== 'string') return res.status(400).json({ error: 'Missing token' });
  writeJson(FCM_TOKENS_FILE, readJson(FCM_TOKENS_FILE, []).filter((item) => item.token !== token));
  res.json({ ok: true });
});

app.post('/api/push/send', authorizeAdmin, async (req, res) => {
  const title = String(req.body && req.body.title || 'Infinity MEN2').slice(0, 120);
  const body = String(req.body && req.body.body || 'لديك تحديث جديد.').slice(0, 500);
  const rawUrl = String(req.body && req.body.url || './index.html').slice(0, 300);
  const tag = String(req.body && req.body.tag || 'infinity-men2-push').slice(0, 80);
  const safeUrl = /^(\/|\.\/|index\.html$)/.test(rawUrl) && !rawUrl.startsWith('//') ? rawUrl : './index.html';

  const subscriptions = readJson(SUBSCRIPTIONS_FILE, []);
  const webPayload = JSON.stringify({ title, body, url: safeUrl, tag });
  const webResults = await Promise.allSettled(subscriptions.map((sub) => webpush.sendNotification(sub, webPayload)));
  const expiredEndpoints = new Set();
  webResults.forEach((result, index) => {
    if (result.status === 'rejected' && result.reason && [404, 410].includes(result.reason.statusCode)) {
      expiredEndpoints.add(subscriptions[index].endpoint);
    }
  });
  if (expiredEndpoints.size) {
    writeJson(SUBSCRIPTIONS_FILE, subscriptions.filter((sub) => !expiredEndpoints.has(sub.endpoint)));
  }

  let androidAttempted = 0;
  let androidSent = 0;
  if (firebaseMessaging) {
    const stored = readJson(FCM_TOKENS_FILE, []);
    const tokens = stored.map((item) => item.token).filter(Boolean);
    androidAttempted = tokens.length;
    for (let index = 0; index < tokens.length; index += 500) {
      const batch = tokens.slice(index, index + 500);
      try {
        const result = await firebaseMessaging.sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data: { url: safeUrl, tag, app: 'InfinityMEN2' },
          android: { priority: 'high', notification: { icon: 'ic_stat_infinity', color: '#D4AF37' } }
        });
        androidSent += result.successCount;
        result.responses.forEach((response, responseIndex) => {
          const code = response.error && response.error.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            const stale = batch[responseIndex];
            const current = readJson(FCM_TOKENS_FILE, []);
            writeJson(FCM_TOKENS_FILE, current.filter((item) => item.token !== stale));
          }
        });
      } catch (error) {
        console.error('FCM batch failed:', error.message);
      }
    }
  }

  res.json({
    ok: true,
    webPush: { attempted: subscriptions.length, sent: webResults.filter((item) => item.status === 'fulfilled').length, removedExpired: expiredEndpoints.size },
    androidPush: { configured: Boolean(firebaseMessaging), attempted: androidAttempted, sent: androidSent }
  });
});

app.listen(PORT, () => {
  console.log(`Infinity MEN2 Push service listening on port ${PORT}`);
  console.log(`Web Push and native FCM are ${firebaseMessaging ? 'ready' : 'partially configured'}.`);
});
