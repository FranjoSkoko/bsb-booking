// Poklon bonovi: narudžba sa stranice (ili Barbara upiše u salonu), Barbara označi da je plaćeno,
// kupac dobije bon za ispis, a u salonu se bon iskoristi po kodu (može i u više navrata).
import crypto from 'node:crypto';
import { q, tx, getSettings } from './db.js';
import { randomToken } from './auth.js';
import { UserError, cleanInput } from './bookings.js';
import { nowLocal, addDays, formatDateHr } from './time.js';
import { buildCustom, sendRaw, adminEmail, baseUrl } from './email.js';
import { notifyAdmin } from './push.js';

export const VOUCHER_STATUS = { naruceno: 'Naručeno', aktivan: 'Aktivan', iskoristen: 'Iskorišten', otkazan: 'Otkazan' };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O i 1/I

export function newCode() {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `BSB-${pick()}-${pick()}`;
}

/** „bsb 7k2m q9xa” → „BSB-7K2M-Q9XA” */
export function normalizeCode(s) {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BSB/, '');
  return raw.length === 8 ? `BSB-${raw.slice(0, 4)}-${raw.slice(4)}` : '';
}

export const voucherLink = (v) => `${baseUrl()}/bon/${v.token}`;
const kmText = (n) => `${Number(n).toLocaleString('hr-HR')} KM`;
const dateText = (d) => formatDateHr(d, { withDay: false });

function toPublic(v) {
  return {
    ...v,
    amount: Number(v.amount),
    balance: Number(v.balance),
    status_label: VOUCHER_STATUS[v.status],
    expired: Boolean(v.expires_on && v.expires_on < nowLocal().date),
    link: voucherLink(v),
  };
}

async function insertVoucher(db, data) {
  for (let i = 0; i < 5; i++) {
    try {
      return (await db.query(
        `INSERT INTO vouchers (code, token, amount, balance, buyer_name, buyer_phone, buyer_email, recipient, message, status, source, expires_on, paid_at)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [newCode(), randomToken(), data.amount, data.buyer_name, data.buyer_phone, data.buyer_email, data.recipient, data.message,
          data.status, data.source, data.expires_on, data.paid_at]
      )).rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err; // isti kod već postoji – probaj drugi
    }
  }
  throw new Error('Kod bona nije moguće stvoriti.');
}

/** Narudžba sa stranice. */
export async function orderVoucher(input) {
  const settings = await getSettings();
  if (!settings.features.vouchers) throw new UserError('Poklon bonovi trenutno nisu dostupni.', 404);
  if (!input.consent) throw new UserError('Za narudžbu je potrebna privola za obradu podataka.');
  const contact = cleanInput({ ...input, note: input.message });
  const amount = Number(input.amount);
  if (!settings.extras.voucherAmounts.includes(amount)) throw new UserError('Odaberite iznos bona.');
  const recipient = String(input.recipient || '').trim().slice(0, 80);
  const v = await insertVoucher({ query: q }, {
    amount, buyer_name: contact.name, buyer_phone: contact.phone, buyer_email: contact.email,
    recipient, message: contact.note, status: 'naruceno', source: 'web', expires_on: null, paid_at: null,
  });
  const biz = settings.business;
  const payment = String(settings.extras.voucherPayment || '').trim();
  const mail = buildCustom('Zaprimili smo narudžbu poklon bona 🎁', [
    `Bok ${contact.name.split(' ')[0]},`,
    'hvala na narudžbi! Zaprimila sam:',
    { box: [`Poklon bon ${kmText(amount)}`, recipient ? `Za: ${recipient}` : 'Bez imena primateljice'] },
    payment || 'Javit ću vam se s uputama za plaćanje.',
    'Kad je bon plaćen, šaljem vam ga emailom – spreman za ispis ili za proslijediti.',
    'Barbara',
  ], biz);
  await sendRaw({ to: contact.email, ...mail, kind: 'bon_narudzba', replyTo: biz.email });
  const toAdmin = buildCustom(`Narudžba poklon bona: ${kmText(amount)}`, [
    { box: [`Poklon bon ${kmText(amount)}${recipient ? ` · za ${recipient}` : ''}`, `${contact.name} · ${contact.phone} · ${contact.email}`, contact.note ? `Poruka na bonu: ${contact.note}` : ''].filter(Boolean) },
    'Kad kupac plati, označite bon kao plaćen u administraciji (Klijentice → Poklon bonovi) i bon mu stiže emailom.',
    { button: 'Otvori poklon bonove', href: `${baseUrl()}/admin#klijentice` },
  ], biz);
  await sendRaw({ to: adminEmail(biz), ...toAdmin, kind: 'bon_admin', replyTo: contact.email });
  await notifyAdmin({ title: 'Narudžba poklon bona', body: `${contact.name} · ${kmText(amount)}${recipient ? ` · za ${recipient}` : ''}`, url: '/admin#klijentice', tag: `v-${v.id}` });
  return { ok: true, amount };
}

async function sendVoucherEmail(v, settings) {
  if (!v.buyer_email) return false;
  const biz = settings.business;
  const mail = buildCustom('Vaš poklon bon je spreman 🎁', [
    `Bok ${String(v.buyer_name || '').split(' ')[0] || ''},`.replace(' ,', ','),
    'hvala! Poklon bon je plaćen i spreman:',
    { box: [`Poklon bon ${kmText(v.amount)}`, `Kod: ${v.code}`, v.recipient ? `Za: ${v.recipient}` : '', v.expires_on ? `Vrijedi do ${dateText(v.expires_on)}` : ''].filter(Boolean) },
    'Bon možete ispisati ili samo proslijediti link. Kod se pokaže u salonu, a termin se rezervira kao i obično.',
    { button: 'Otvori i ispiši bon', href: voucherLink(v) },
    'Barbara',
  ], biz);
  return sendRaw({ to: v.buyer_email, ...mail, kind: 'bon_poslan', replyTo: biz.email });
}

/** Plaćeno – bon postaje aktivan i šalje se kupcu. */
export async function markPaid(id, { notify = true } = {}) {
  const settings = await getSettings();
  const months = settings.extras.voucherMonths || 12;
  const cur = (await q('SELECT * FROM vouchers WHERE id = $1', [id])).rows[0];
  if (!cur) throw new UserError('Bon ne postoji.', 404);
  if (cur.status !== 'naruceno') throw new UserError(`Bon je već: ${VOUCHER_STATUS[cur.status]}.`, 409);
  const expires = addMonths(nowLocal().date, months);
  const v = (await q(`UPDATE vouchers SET status = 'aktivan', paid_at = now(), expires_on = $2 WHERE id = $1 RETURNING *`, [id, expires])).rows[0];
  const sent = notify ? await sendVoucherEmail(v, settings) : false;
  return { ...toPublic(v), sent };
}

export function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** Bon napravljen u salonu (plaćen na licu mjesta). */
export async function createInSalon(input) {
  const settings = await getSettings();
  const amount = Number(input.amount);
  if (!(amount >= 5 && amount <= 2000)) throw new UserError('Upišite iznos bona (5 – 2000 KM).');
  const contact = cleanInput({ name: input.buyer_name || 'Kupac u salonu', phone: input.buyer_phone, email: input.buyer_email }, { requireContact: false });
  const v = await insertVoucher({ query: q }, {
    amount, buyer_name: input.buyer_name ? contact.name : '', buyer_phone: contact.phone, buyer_email: contact.email,
    recipient: String(input.recipient || '').trim().slice(0, 80), message: String(input.message || '').trim().slice(0, 300),
    status: 'aktivan', source: 'salon', expires_on: addMonths(nowLocal().date, settings.extras.voucherMonths || 12), paid_at: new Date(),
  });
  const sent = input.notify && v.buyer_email ? await sendVoucherEmail(v, settings) : false;
  return { ...toPublic(v), sent };
}

export async function adminVouchers() {
  const { rows } = await q(
    `SELECT * FROM vouchers
     WHERE status IN ('naruceno','aktivan') OR created_at > now() - interval '60 days'
     ORDER BY (status = 'naruceno') DESC, (status = 'aktivan') DESC, created_at DESC LIMIT 200`
  );
  return rows.map(toPublic);
}

export async function findVoucher(code) {
  const c = normalizeCode(code);
  if (!c) throw new UserError('Upišite kod s bona (npr. BSB-7K2M-Q9XA).');
  const v = (await q('SELECT * FROM vouchers WHERE code = $1', [c])).rows[0];
  if (!v) throw new UserError('Bon s tim kodom ne postoji.', 404);
  return toPublic(v);
}

/** Iskoristi (dio) bona. */
export async function redeem(code, amount, note = '') {
  const c = normalizeCode(code);
  const sum = Math.round(Number(amount) * 100) / 100;
  if (!(sum > 0)) throw new UserError('Upišite iznos koji se plaća bonom.');
  return tx(async (db) => {
    const v = (await db.query('SELECT * FROM vouchers WHERE code = $1 FOR UPDATE', [c])).rows[0];
    if (!v) throw new UserError('Bon s tim kodom ne postoji.', 404);
    if (v.status === 'naruceno') throw new UserError('Bon još nije plaćen.', 409);
    if (v.status !== 'aktivan') throw new UserError(`Bon je ${VOUCHER_STATUS[v.status].toLowerCase()}.`, 409);
    if (v.expires_on && v.expires_on < nowLocal().date) throw new UserError(`Bon je istekao ${dateText(v.expires_on)}.`, 409);
    const balance = Number(v.balance);
    if (sum > balance + 0.001) throw new UserError(`Na bonu je ostalo ${kmText(balance)}.`, 409);
    const left = Math.round((balance - sum) * 100) / 100;
    const entry = { date: nowLocal().date, amount: sum, note: String(note || '').slice(0, 120) };
    const r = await db.query(
      `UPDATE vouchers SET balance = $2, status = $3, redemptions = redemptions || $4::jsonb WHERE id = $1 RETURNING *`,
      [v.id, left, left <= 0 ? 'iskoristen' : 'aktivan', JSON.stringify([entry])]
    );
    return toPublic(r.rows[0]);
  });
}

export async function cancelVoucher(id) {
  const r = await q(`UPDATE vouchers SET status = 'otkazan' WHERE id = $1 AND status IN ('naruceno','aktivan') RETURNING *`, [id]);
  if (!r.rowCount) throw new UserError('Bon se ne može otkazati.', 409);
  return toPublic(r.rows[0]);
}

export async function voucherByToken(token) {
  const v = (await q('SELECT * FROM vouchers WHERE token = $1', [String(token || '')])).rows[0];
  return v ? toPublic(v) : null;
}
