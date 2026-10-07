// Upiti za vjenčanja i svečanosti: klijentica pošalje upit sa stranice, Barbara se dogovori,
// pošalje upute za kaparu i označi kad je kapara plaćena.
import { q, getSettings } from './db.js';
import { randomToken } from './auth.js';
import { UserError, cleanInput } from './bookings.js';
import { nowLocal, addDays, parseYmd, formatDateHr, toMin, toHHMM } from './time.js';
import { buildCustom, sendRaw, adminEmail, baseUrl } from './email.js';
import { telHref, waHref } from './phone.js';
import { notifyAdmin } from './push.js';

export const EVENT_KINDS = {
  vjencanje: 'Vjenčanje',
  krizma: 'Krizma ili pričest',
  matura: 'Maturalna večer',
  ostalo: 'Druga svečanost',
};
export const INQUIRY_STATUS = {
  novi: 'Novi upit',
  kapara_poslana: 'Čeka kaparu',
  potvrdeno: 'Kapara plaćena',
  zatvoreno: 'Zatvoreno',
};

const kindLabel = (i) => EVENT_KINDS[i.kind] || EVENT_KINDS.ostalo;
const summary = (i) => [
  `${kindLabel(i)} · ${formatDateHr(i.event_date)}`,
  [i.ready_by ? `spremna do ${i.ready_by}` : '', `${i.people} ${i.people === 1 ? 'osoba' : 'osobe'}`, i.location].filter(Boolean).join(' · '),
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function addInquiry(input) {
  const settings = await getSettings();
  if (!settings.features.events) throw new UserError('Upiti trenutno nisu dostupni.', 404);
  if (!input.consent) throw new UserError('Za slanje upita potrebna je privola za obradu podataka.');
  const contact = cleanInput(input);
  const date = String(input.date || '');
  const now = nowLocal();
  if (!parseYmd(date) || date < now.date || date > addDays(now.date, 3 * 365)) throw new UserError('Odaberite datum svečanosti.');
  const ready = input.readyBy ? toMin(String(input.readyBy)) : null;
  if (input.readyBy && ready == null) throw new UserError('Neispravno vrijeme.');
  const people = Math.min(30, Math.max(1, Math.round(Number(input.people)) || 1));
  const kind = EVENT_KINDS[input.kind] ? input.kind : 'ostalo';
  const location = String(input.location || '').trim().slice(0, 120);

  const row = (await q(
    `INSERT INTO inquiries (token, kind, name, phone, email, event_date, ready_by, people, location, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [randomToken(), kind, contact.name, contact.phone, contact.email, date, ready == null ? '' : toHHMM(ready), people, location, contact.note]
  )).rows[0];

  const biz = settings.business;
  const toClient = buildCustom('Zaprimila sam vaš upit 🤍', [
    `Bok ${row.name.split(' ')[0]},`,
    'hvala na upitu! Ovo sam zaprimila:',
    { box: summary(row) },
    'Javit ću vam se uskoro da se dogovorimo oko detalja i cijene. Datum je rezerviran tek kad se dogovorimo i kad je plaćena kapara.',
    'Barbara',
  ], biz);
  await sendRaw({ to: row.email, ...toClient, kind: 'upit_klijentica', replyTo: biz.email });
  const tel = telHref(row.phone);
  const toAdmin = buildCustom(`Upit: ${kindLabel(row)} – ${formatDateHr(row.event_date)}`, [
    { box: [...summary(row), `${row.name} · ${row.phone} · ${row.email}`, row.note ? `Napomena: ${row.note}` : 'Bez napomene'] },
    tel ? `<a href="${tel}">Nazovi</a> · <a href="${waHref(row.phone)}">WhatsApp</a>` : '',
    { button: 'Otvori upite', href: `${baseUrl()}/admin#zahtjevi` },
  ].filter(Boolean), biz);
  await sendRaw({ to: adminEmail(biz), ...toAdmin, kind: 'upit_admin', replyTo: row.email });
  await notifyAdmin({
    title: `Upit: ${kindLabel(row)}`,
    body: `${row.name} · ${formatDateHr(row.event_date)}${row.people > 1 ? ` · ${row.people} osobe` : ''}`,
    url: '/admin#zahtjevi',
    tag: `inq-${row.id}`,
  });
  return { ok: true };
}

/** Otvoreni upiti (i potvrđeni do datuma svečanosti) + koliko termina Barbara već ima taj dan. */
export async function adminInquiries() {
  const { rows } = await q(
    `SELECT i.*, i.deposit::float AS deposit,
       (SELECT count(*)::int FROM bookings b WHERE b.date = i.event_date AND b.status IN ('potvrdeno','na_cekanju')) AS day_bookings
     FROM inquiries i
     WHERE i.status IN ('novi','kapara_poslana') OR (i.status = 'potvrdeno' AND i.event_date >= $1)
     ORDER BY i.event_date, i.created_at`,
    [nowLocal().date]
  );
  return rows.map((r) => ({ ...r, kind_label: kindLabel(r), status_label: INQUIRY_STATUS[r.status] }));
}

async function load(id) {
  const r = (await q('SELECT * FROM inquiries WHERE id = $1', [id])).rows[0];
  if (!r) throw new UserError('Upit ne postoji.', 404);
  return r;
}

export async function updateInquiry(id, input) {
  const cur = await load(id);
  const status = INQUIRY_STATUS[input.status] ? input.status : cur.status;
  const deposit = input.deposit === '' || input.deposit === null ? null
    : input.deposit !== undefined ? Math.max(0, Number(input.deposit)) : cur.deposit;
  if (deposit !== null && !Number.isFinite(Number(deposit))) throw new UserError('Neispravan iznos kapare.');
  const note = input.admin_note !== undefined ? String(input.admin_note).slice(0, 1000) : cur.admin_note;
  return (await q('UPDATE inquiries SET status = $2, deposit = $3, admin_note = $4 WHERE id = $1 RETURNING *', [id, status, deposit, note])).rows[0];
}

/** Pošalji klijentici upute za plaćanje kapare (tekst iz Postavki). */
export async function requestDeposit(id, amount) {
  const settings = await getSettings();
  const info = String(settings.extras.depositInfo || '').trim();
  if (!info) throw new UserError('Prvo upišite upute za kaparu u Postavke → Dodatne mogućnosti → Vjenčanja i svečanosti.');
  const deposit = Number(amount);
  if (!(deposit > 0)) throw new UserError('Upišite iznos kapare.');
  const cur = await load(id);
  if (!cur.email) throw new UserError('Klijentica nema email – javite joj se telefonom.');
  const biz = settings.business;
  const mail = buildCustom(`Kapara za ${kindLabel(cur).toLowerCase()} · ${formatDateHr(cur.event_date, { withDay: false })}`, [
    `Bok ${cur.name.split(' ')[0]},`,
    `kako smo se dogovorile, datum ${formatDateHr(cur.event_date)} rezervirat ću vam uz kaparu od <strong>${deposit.toLocaleString('hr-HR')} KM</strong>.`,
    { box: info.split('\n').map((l) => l.trim()).filter(Boolean) },
    'Čim kapara stigne, potvrdit ću vam datum emailom.',
    `Za sva pitanja javite mi se na <a href="${telHref(biz.phone)}">${esc(biz.phone)}</a>.`,
    'Barbara',
  ], biz);
  if (!(await sendRaw({ to: cur.email, ...mail, kind: 'upit_kapara', replyTo: biz.email }))) {
    throw new UserError('Email nije poslan – provjerite slanje emailova (Postavke → Email).');
  }
  return (await q(`UPDATE inquiries SET status = 'kapara_poslana', deposit = $2, deposit_sent_at = now() WHERE id = $1 RETURNING *`, [id, deposit])).rows[0];
}

/** Kapara je stigla – potvrdi datum klijentici. */
export async function depositPaid(id, { notify = true } = {}) {
  const settings = await getSettings();
  const cur = await load(id);
  const row = (await q(`UPDATE inquiries SET status = 'potvrdeno', deposit_paid_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (notify && cur.email) {
    const biz = settings.business;
    const mail = buildCustom('Datum je rezerviran ✨', [
      `Bok ${cur.name.split(' ')[0]},`,
      `kapara je zaprimljena${cur.deposit ? ` (${Number(cur.deposit).toLocaleString('hr-HR')} KM)` : ''} – hvala! Vaš datum je rezerviran:`,
      { box: summary(cur) },
      'Javit ću vam se pred svečanost oko probe i detalja. Veselim se!',
      'Barbara',
    ], biz);
    await sendRaw({ to: cur.email, ...mail, kind: 'upit_potvrda', replyTo: biz.email });
  }
  return row;
}
