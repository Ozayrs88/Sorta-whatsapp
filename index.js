import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import axios from 'axios';
import pino from 'pino';

const SORTA_URL = process.env.SORTA_URL?.replace(/\/$/, '');
const INTAKE_SECRET = process.env.WHATSAPP_INTAKE_SECRET;
// Railway injects RAILWAY_VOLUME_MOUNT_PATH automatically when a volume is attached.
// That's the preferred path. AUTH_STATE_PATH lets you override manually if needed.
// Falls back to ./auth_state for local development.
const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/auth_state` : 'auth_state');

if (!SORTA_URL || !INTAKE_SECRET) {
  console.error('Missing SORTA_URL or WHATSAPP_INTAKE_SECRET in .env');
  process.exit(1);
}

const logger = pino({ level: 'silent' }); // suppress Baileys internal noise

async function forwardToSorta({ from, body, mediaBuffer, mimeType, filename }) {
  const mediaBase64 = mediaBuffer.toString('base64');
  try {
    const res = await axios.post(
      `${SORTA_URL}/api/whatsapp/intake`,
      { from, body: body || '', mediaBase64, mimeType, filename, secret: INTAKE_SECRET },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
    console.log(`[sorta] ✓ forwarded ${filename} → ${res.data?.classification || 'unknown'}`);
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
    printQRInTerminal: false, // we handle QR ourselves for nicer formatting
    browser: ['Sorta', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n── Scan this QR code in WhatsApp → Linked Devices ──\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n────────────────────────────────────────────────────\n');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[ws] connection closed (${statusCode}) — ${shouldReconnect ? 'reconnecting…' : 'logged out, delete auth_state/ to re-link'}`);
      if (shouldReconnect) {
        setTimeout(startSock, 3000);
      }
    }

    if (connection === 'open') {
      console.log('[ws] ✓ WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip own messages, group chats, and status broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
      const body = msg.message?.conversation
        || msg.message?.imageMessage?.caption
        || msg.message?.documentMessage?.caption
        || msg.message?.videoMessage?.caption
        || '';

      const msgContent = msg.message;
      const mediaType = msgContent?.imageMessage ? 'image'
        : msgContent?.documentMessage ? 'document'
        : msgContent?.videoMessage ? 'video'
        : null;

      if (!mediaType) {
        // Text-only message — send a helpful nudge
        if (body.trim()) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: 'Hi! Send me a photo of a receipt, invoice, or site — and I\'ll send it straight to Sorta.',
          });
        }
        continue;
      }

      console.log(`[msg] ${from} → ${mediaType} "${body.slice(0, 60)}"`);

      let mediaBuffer;
      try {
        mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      } catch (err) {
        console.error(`[msg] failed to download media: ${err.message}`);
        await sock.sendMessage(msg.key.remoteJid, { text: 'Sorry, I couldn\'t download that file. Please try again.' });
        continue;
      }

      // Derive filename and MIME type
      const imgMsg = msgContent?.imageMessage;
      const docMsg = msgContent?.documentMessage;
      const vidMsg = msgContent?.videoMessage;
      const mimeType = imgMsg?.mimetype || docMsg?.mimetype || vidMsg?.mimetype || 'image/jpeg';
      const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
      const filename = docMsg?.fileName || `${mediaType}_${Date.now()}.${ext}`;

      const result = await forwardToSorta({ from, body, mediaBuffer, mimeType, filename });

      // Reply to sender based on what Sorta classified it as
      let replyText;
      if (!result) {
        replyText = 'Received, but there was an issue sending it to Sorta. Check the server logs.';
      } else if (result.classification === 'site_photo') {
        replyText = result.property
          ? `Site photo saved to "${result.property}" in Sorta.`
          : 'Site photo saved to Sorta (unassigned — you can link it to a property in the app).';
      } else {
        replyText = 'Receipt/invoice received — processing it now. It\'ll appear in Sorta shortly.';
      }

      await sock.sendMessage(msg.key.remoteJid, { text: replyText });
    }
  });
}

console.log('[sorta-whatsapp] starting…');
startSock().catch(console.error);
