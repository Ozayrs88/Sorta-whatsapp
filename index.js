import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import axios from 'axios';
import pino from 'pino';
import http from 'http';

const SORTA_URL = process.env.SORTA_URL?.replace(/\/$/, '');
const INTAKE_SECRET = process.env.WHATSAPP_INTAKE_SECRET;
// Railway injects RAILWAY_VOLUME_MOUNT_PATH automatically when a volume is attached.
// AUTH_STATE_PATH lets you override manually if needed.
// Falls back to ./auth_state for local development.
const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/auth_state` : 'auth_state');

if (!SORTA_URL || !INTAKE_SECRET) {
  console.error('Missing SORTA_URL or WHATSAPP_INTAKE_SECRET in .env');
  process.exit(1);
}

const SIDECAR_PORT = parseInt(process.env.PORT || process.env.SIDECAR_PORT || '3001', 10);

const logger = pino({ level: 'silent' });

// Live state exposed via the /qr HTTP endpoint
let currentQRDataUrl = null;
let isConnected = false;

// ── Tiny status HTTP server ──────────────────────────────────────────────────
// GET /qr?secret=... → { connected, qr }
// Sorta's /api/whatsapp/status proxies this so the settings page can render
// the QR code or a "Connected" badge without anyone digging through Railway logs.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (req.method !== 'GET' || url.pathname !== '/qr') {
    res.writeHead(404);
    res.end();
    return;
  }
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== INTAKE_SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ connected: isConnected, qr: currentQRDataUrl }));
});

server.listen(SIDECAR_PORT, () => {
  console.log(`[http] status server listening on port ${SIDECAR_PORT}`);
});

// Cache group names so we don't fetch metadata on every message
const groupNameCache = new Map();

async function getGroupName(sock, jid) {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const metadata = await sock.groupMetadata(jid);
    groupNameCache.set(jid, metadata.subject);
    return metadata.subject;
  } catch {
    return jid;
  }
}

async function forwardToSorta({ from, body, mediaBuffer, mimeType, filename, groupJid, groupName }) {
  const mediaBase64 = mediaBuffer.toString('base64');
  try {
    const res = await axios.post(
      `${SORTA_URL}/api/whatsapp/intake`,
      { from, body: body || '', mediaBase64, mimeType, filename, secret: INTAKE_SECRET, groupJid, groupName },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    console.log(`[sorta] ✓ ${groupName} / ${filename} → ${res.data?.classification || 'unknown'}${res.data?.property ? ` (${res.data.property})` : ''}`);
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    console.error(`[sorta] ✗ forward failed: ${msg}`);
    return null;
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_STATE_PATH);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Sorta', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Store as PNG data URL for the settings page QR display
      currentQRDataUrl = await QRCode.toDataURL(qr).catch(() => null);
      isConnected = false;
      // Also print to terminal as a fallback
      console.log('\n── Scan QR in WhatsApp → Linked Devices (or open Sorta Settings) ──\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n──────────────────────────────────────────────────────────────────\n');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[ws] connection closed (${statusCode}) — ${shouldReconnect ? 'reconnecting…' : 'logged out, delete auth_state/ to re-link'}`);
      if (shouldReconnect) setTimeout(startSock, 3000);
    }

    if (connection === 'open') {
      isConnected = true;
      currentQRDataUrl = null; // clear QR once connected
      console.log('[ws] ✓ WhatsApp connected');

      // Log all current groups on startup so you can identify their JIDs
      try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);
        if (groupList.length > 0) {
          console.log('\n── Your WhatsApp Groups (copy the JID for the group you want to use) ──');
          groupList.forEach(g => {
            groupNameCache.set(g.id, g.subject);
            console.log(`  "${g.subject}"  →  ${g.id}`);
          });
          console.log('────────────────────────────────────────────────────────────────────\n');
        }
      } catch (err) {
        console.warn('[ws] could not fetch group list:', err.message);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      // Only process group messages — DMs are ignored
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;

      const groupJid = msg.key.remoteJid;
      const sender = msg.key.participant || groupJid;
      const groupName = await getGroupName(sock, groupJid);

      const msgContent = msg.message;
      const body = msgContent?.conversation
        || msgContent?.imageMessage?.caption
        || msgContent?.documentMessage?.caption
        || msgContent?.videoMessage?.caption
        || '';

      const mediaType = msgContent?.imageMessage ? 'image'
        : msgContent?.documentMessage ? 'document'
        : msgContent?.videoMessage ? 'video'
        : null;

      if (!mediaType) continue; // ignore text-only group messages

      console.log(`[msg] "${groupName}" / ${sender} → ${mediaType}`);

      let mediaBuffer;
      try {
        mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      } catch (err) {
        console.error(`[msg] failed to download media: ${err.message}`);
        continue;
      }

      const mimeType = msgContent?.imageMessage?.mimetype
        || msgContent?.documentMessage?.mimetype
        || msgContent?.videoMessage?.mimetype
        || 'image/jpeg';
      const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
      const filename = msgContent?.documentMessage?.fileName || `${mediaType}_${Date.now()}.${ext}`;

      const result = await forwardToSorta({ from: sender, body, mediaBuffer, mimeType, filename, groupJid, groupName });

      // Reply in the group so sender knows it was received
      let replyText;
      if (!result) {
        replyText = '⚠️ Received, but there was an issue sending it to Sorta.';
      } else if (result.classification === 'site_photo') {
        replyText = result.property
          ? `📸 Site photo filed under "${result.property}".`
          : '📸 Site photo saved — no property matched, assigned to Unassigned.';
      } else {
        replyText = '✅ Document received — processing it now. It\'ll appear in Sorta shortly.';
      }

      await sock.sendMessage(groupJid, { text: replyText });
    }
  });
}

console.log('[sorta-whatsapp] starting…');
startSock().catch(console.error);
