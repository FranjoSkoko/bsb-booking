// Recenzije: nakon termina klijentica ocijeni uslugu (link u emailu zahvale),
// Barbara ih odobri, a odobrene se vide na stranici u sekciji „Dojmovi”.
import { q } from './db.js';
import { baseUrl } from './email.js';
import { hasStarted } from './bookings.js';
import { notifyAdmin } from './push.js';

export const reviewLink = (b) => `${baseUrl()}/recenzija/${b.token}`;

/** „Ana Anić” → „Ana A.” */
export function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Klijentica';
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
}

/** Smije li se za ovu rezervaciju ostaviti recenzija. */
export const canReview = (b) => Boolean(b && b.status === 'potvrdeno' && hasStarted(b));

export async function reviewFor(bookingId) {
  return (await q('SELECT * FROM reviews WHERE booking_id = $1', [bookingId])).rows[0] || null;
}

/** Spremi ocjenu; dok je Barbara nije pregledala, klijentica je može promijeniti. */
export async function saveReview(b, { rating, text }) {
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5)) return { error: 'Odaberite ocjenu od 1 do 5 zvjezdica.' };
  const body = String(text || '').trim().replace(/\r\n/g, '\n').slice(0, 1000);
  const existing = await reviewFor(b.id);
  if (existing && existing.status !== 'nova') return { error: 'Za ovaj termin ocjena je već zaprimljena. Hvala!' };
  const services = b.services.map((s) => s.name).join(' + ');
  const row = existing
    ? (await q('UPDATE reviews SET rating = $2, text = $3 WHERE id = $1 RETURNING *', [existing.id, r, body])).rows[0]
    : (await q('INSERT INTO reviews (booking_id, client_id, name, rating, text, services) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [b.id, b.client_id, b.name, r, body, services])).rows[0];
  if (!existing) {
    await notifyAdmin({
      title: `Nova recenzija ${'★'.repeat(r)}`,
      body: `${b.name} · ${services}${body ? ` – „${body.slice(0, 80)}${body.length > 80 ? '…' : ''}”` : ''}`,
      url: '/admin#klijentice',
      tag: `rv-${row.id}`,
    });
  }
  return { review: row };
}

/** Za stranicu: objavljene recenzije i prosjek. */
export async function publicReviews(limit = 12) {
  const agg = (await q(`SELECT count(*)::int AS n, coalesce(avg(rating), 0)::float AS avg FROM reviews WHERE status = 'objavljena'`)).rows[0];
  const items = (await q(
    `SELECT name, rating, text, services, created_at FROM reviews WHERE status = 'objavljena' ORDER BY (text <> '') DESC, created_at DESC LIMIT $1`,
    [limit]
  )).rows;
  return {
    count: agg.n,
    avg: Math.round(agg.avg * 10) / 10,
    items: items.map((x) => ({ name: shortName(x.name), rating: x.rating, text: x.text, services: x.services, date: x.created_at })),
  };
}

export async function adminReviews() {
  return (await q(`SELECT r.*, b.date FROM reviews r LEFT JOIN bookings b ON b.id = r.booking_id ORDER BY (r.status = 'nova') DESC, r.created_at DESC LIMIT 200`)).rows;
}

export async function setReviewStatus(id, status) {
  if (!['objavljena', 'skrivena', 'nova'].includes(status)) return null;
  return (await q('UPDATE reviews SET status = $2 WHERE id = $1 RETURNING *', [id, status])).rows[0] || null;
}
