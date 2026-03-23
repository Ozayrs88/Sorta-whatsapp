import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import axios from 'axios';
import http from 'http';
import fs from 'fs';
import path from 'path';

const SORTA_URL = process.env.SORTA_URL?.replace(/\/$/, '');
const INTAKE_SECRET = process.env.WHATSAPP_INTAKE_SECRET;
const SIDECAR_PORT = parseInt(process.env.PORT || process.env.SIDECAR_PORT || '3001', 10);

// Session is stored in the Railway volume. Default to /data so LocalAuth writes
// to /data/.wwebjs_auth/ — consistent with the original mount point.
const DATA_PATH = process.env.AUTH_STATE_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';

if (!SORTA_URL || !INTAKE_SECRET) {
  console.error('Missing SORTA_URL or WHATSAPP_INTAKE_SECRET in .env');
  process.exit(1);
}

// ── Live state for the /qr status endpoint ────────────────────────────────────
let currentQRDataUrl = null;
let isConnected = false;
let cachedGroups = []; // { jid, name }

// ── Tiny HTTP status server ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (req.method !== 'GET' || url.pathname !== '/qr') {
    res.writeHead(404); res.end(); return;
  }
  if (url.searchParams.get('secret') !== INTAKE_SECRET) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ connected: isConnected, qr: currentQRDataUrl, groups: cachedGroups }));
});

server.listen(SIDECAR_PORT, () => {
  console.log(`[http] status server on port ${SIDECAR_PORT}`);
});

// Recursively remove Chromium lock files from the session directory.
// LocalAuth stores the browser profile at {DATA_PATH}/.wwebjs_auth/session/
// and Chromium writes SingletonLock there, blocking restarts if not cleaned up.
function removeLockFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (['SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(entry.name)) {
        fs.unlinkSync(full);
        console.log(`[init] removed stale lock file: ${full}`);
      } else if (entry.isDirectory()) {
        removeLockFiles(full);
      }
    }
  } catch { /* non-critical */ }
}
removeLockFiles(DATA_PATH);

// ── WhatsApp client ───────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: DATA_PATH }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    timeout: 90000,
    protocolTimeout: 90000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--safebrowsing-disable-auto-update',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-hang-monitor',
    ],
  },
});

client.on('qr', async (qr) => {
  currentQRDataUrl = await QRCode.toDataURL(qr).catch(() => null);
  isConnected = false;
  console.log('[ws] QR ready — open Sorta Settings → WhatsApp to scan');
});

client.on('authenticated', () => {
  isConnected = true;
  currentQRDataUrl = null;
  console.log('[ws] ✓ authenticated');
});

client.on('ready', async () => {
  isConnected = true;
  currentQRDataUrl = null;
  console.log('[ws] ✓ WhatsApp ready');

  // Cache groups in memory so the /qr endpoint can return them
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  cachedGroups = groups.map(g => ({ jid: g.id._serialized, name: g.name }));
  console.log(`[ws] cached ${cachedGroups.length} groups`);
  console.log('\n── Your WhatsApp Groups ──');
  groups.forEach(g => console.log(`  "${g.name}"  →  ${g.id._serialized}`));
  console.log('─────────────────────────\n');
});

client.on('disconnected', (reason) => {
  isConnected = false;
  console.log('[ws] disconnected:', reason, '— restarting…');
  setTimeout(() => client.initialize(), 5000);
});

client.on('message', async (msg) => {
  // Only handle incoming group messages with media
  if (msg.fromMe) return;
  if (!msg.from.endsWith('@g.us')) return;
  if (!msg.hasMedia) return;

  const chat = await msg.getChat();
  const groupJid = msg.from;
  const groupName = chat.name;
  const sender = msg.author || msg.from;

  console.log(`[msg] "${groupName}" / ${sender} → ${msg.type}`);

  let media;
  try {
    media = await msg.downloadMedia();
  } catch (err) {
    console.error(`[msg] failed to download media: ${err.message}`);
    await msg.reply('⚠️ Could not download that file. Please try again.');
    return;
  }

  if (!media?.data) {
    console.warn('[msg] media downloaded but no data');
    return;
  }

  const mimeType = media.mimetype || 'image/jpeg';
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
  const filename = media.filename || `${msg.type}_${Date.now()}.${ext}`;
  const body = msg.body || '';

  const result = await forwardToSorta({
    from: sender,
    body,
    mediaBase64: media.data,
    mimeType,
    filename,
    groupJid,
    groupName,
  });

  let replyText;
  if (!result) {
    replyText = '⚠️ Received but there was an issue sending to Sorta. Check logs.';
  } else if (result.classification === 'site_photo') {
    replyText = result.property
      ? `📸 Site photo filed under "${result.property}".`
      : '📸 Site photo saved — no property matched, filed as Unassigned.';
  } else {
    replyText = '✅ Document received — processing now. It\'ll appear in Sorta shortly.';
  }

  await msg.reply(replyText);
});

async function forwardToSorta({ from, body, mediaBase64, mimeType, filename, groupJid, groupName }) {
  try {
    const res = await axios.post(
      `${SORTA_URL}/api/whatsapp/intake`,
      { from, body, mediaBase64, mimeType, filename, secret: INTAKE_SECRET, groupJid, groupName },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    console.log(`[sorta] ✓ ${groupName} / ${filename} → ${res.data?.classification || '?'}${res.data?.property ? ` (${res.data.property})` : ''}`);
    return res.data;
  } catch (err) {
    console.error(`[sorta] ✗ ${err.response?.data?.error || err.message}`);
    return null;
  }
}

// Guard against concurrent reinitializations
let reinitPending = false;

async function safeReinit() {
  if (reinitPending) return;
  reinitPending = true;
  console.warn('[init] scheduling reinitialization in 8s…');
  try { await client.destroy(); } catch { /* ignore */ }
  removeLockFiles(DATA_PATH);
  await new Promise(r => setTimeout(r, 8000));
  reinitPending = false;
  console.warn('[init] reinitializing client…');
  client.initialize().catch(() => {});
}

// Catch known recoverable whatsapp-web.js errors so the process doesn't die
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  const recoverable = [
    'Execution context was destroyed',
    'Session closed',
    'browser is already running',
    'Target closed',
    'detached Frame',
    'Detached Frame',
  ];
  if (recoverable.some(s => msg.includes(s))) {
    console.warn('[init] recoverable error, reinitializing:', msg.split('\n')[0]);
    safeReinit();
  } else {
    console.error('[fatal] unhandled rejection:', reason);
    process.exit(1);
  }
});

console.log('[sorta-whatsapp] starting…');
client.initialize();
