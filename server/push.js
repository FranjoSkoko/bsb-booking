// Obavijesti na Barbarin mobitel (Web Push). Ključevi se stvore sami pri prvom korištenju.
import webpush from 'web-push';
import { q, getSettings, getSecret } from './db.js';

let configured = null;

async function vapid() {
  if (configured) return configured;
  const keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : await getSecret('vapid', () => webpush.generateVAPIDKeys());
  const email = (await getSettings()).business.email || 'info@barbaraskokobeauty.com';
  webpush.setVapidDetails(`mailto:${email}`, keys.publicKey, keys.privateKey);
  configured = keys;
  return keys;
}

export const publicKey = async () => (await vapid()).publicKey;

export async function saveSubscription(sub, label = '') {
  const endpoint = String(sub?.endpoint || '');
  const keys = sub?.keys || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) throw new Error('Neispravna pretplata na obavijesti.');
  await q(
    `INSERT INTO push_subscriptions (endpoint, keys, label) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, label = EXCLUDED.label`,
    [endpoint, JSON.stringify({ p256dh: String(keys.p256dh), auth: String(keys.auth) }), String(label).slice(0, 80)]
  );
}

export async function listDevices() {
  return (await q('SELECT id, label, created_at, last_ok_at FROM push_subscriptions ORDER BY id')).rows;
}

export async function removeDevice(id) {
  await q('DELETE FROM push_subscriptions WHERE id = $1', [id]);
}

/** Pošalji obavijest na sve Barbarine uređaje. Vraća broj uspješno poslanih. */
export async function notifyAdmin({ title, body = '', url = '/admin', tag }, { force = false } = {}) {
  if (!force && !(await getSettings()).features.push) return 0;
  const subs = (await q('SELECT * FROM push_subscriptions')).rows;
  if (!subs.length) return 0;
  await vapid();
  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 24 * 3600, timeout: 10000 });
      await q('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [s.id]);
      sent++;
    } catch (err) {
      // Uređaj je odjavljen ili je obrisao pretplatu
      if (err.statusCode === 404 || err.statusCode === 410) await removeDevice(s.id);
      else console.error('[obavijest]', err.statusCode || '', err.body || err.message);
    }
  }
  return sent;
}
