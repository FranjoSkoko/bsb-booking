import { q, tx, getSettings, getServices } from './db.js';
import { daySlots, combine, BUSY_STATUSES } from './slots.js';
import { nowLocal, addDays, parseYmd, toMin, wallMinutes } from './time.js';
import { randomToken } from './auth.js';
import { sendBookingEmail } from './email.js';
import { emit } from './hooks.js';
import { closedHolidays } from './holidays.js';
import { phoneDigits } from './phone.js';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const STATUS_LABEL = {
  na_cekanju: 'Na čekanju',
  potvrdeno: 'Potvrđeno',
  odbijeno: 'Odbijeno',
  otkazano: 'Otkazano',
  nije_dosla: 'Nije došla',
};

export function rowToBooking(r) {
  return {
    id: r.id,
    token: r.token,
    client_id: r.client_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    date: r.date,
    start_min: r.start_min,
    duration: r.duration,
    services: r.services,
    total_price: Number(r.total_price),
    note: r.note,
    admin_note: r.admin_note,
    status: r.status,
    status_label: STATUS_LABEL[r.status] || r.status,
    source: r.source,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
    cancelled_at: r.cancelled_at,
    cancelled_by: r.cancelled_by,
    reminder_sent_at: r.reminder_sent_at,
    thanks_sent_at: r.thanks_sent_at,
    started: hasStarted(r),
  };
}

/** Je li termin već počeo (ili prošao). */
export function hasStarted(b, now = nowLocal()) {
  return wallMinutes(b.date, b.start_min) <= wallMinutes(now.date, now.min);
}

/** Zauzeti intervali po danima: { 'YYYY-MM-DD': [{start, end}] } */
export async function busyMap(db, from, to, { excludeId = null } = {}) {
  const map = {};
  const push = (d, start, end) => (map[d] ||= []).push({ start, end });
  const b = await db.query(
    `SELECT id, date, start_min, duration FROM bookings
     WHERE date BETWEEN $1 AND $2 AND status = ANY($3) AND ($4::int IS NULL OR id <> $4)`,
    [from, to, BUSY_STATUSES, excludeId]
  );
  for (const r of b.rows) push(r.date, r.start_min, r.start_min + r.duration);
  const bl = await db.query('SELECT date, start_min, end_min FROM blocks WHERE date BETWEEN $1 AND $2 AND NOT open', [from, to]);
  for (const r of bl.rows) push(r.date, r.start_min ?? 0, r.end_min ?? 1440);
  return map;
}

/** Dodatno otvorena vremena po danima: { 'YYYY-MM-DD': [[start, end]] } */
export async function extraMap(db, from, to) {
  const map = {};
  const r = await db.query('SELECT date, start_min, end_min FROM blocks WHERE date BETWEEN $1 AND $2 AND open', [from, to]);
  for (const x of r.rows) (map[x.date] ||= []).push([x.start_min, x.end_min]);
  return map;
}

// Na praznik se nudi samo ono što je Barbara dodatno otvorila
const hoursFor = (settings, holiday) => (holiday ? {} : settings.hours);

export async function resolveServices(ids, { allowInactive = false } = {}) {
  const all = await getServices({ onlyActive: !allowInactive });
  const list = [...new Set(ids)].map((id) => all.find((s) => s.id === id)).filter(Boolean);
  if (!list.length) throw new UserError('Odaberite barem jednu uslugu.');
  if (list.length !== new Set(ids).size) throw new UserError('Odabrana usluga više nije dostupna.');
  return list;
}

/** Slobodni termini za odabrane usluge na jedan dan. */
export async function slotsFor(serviceIds, date) {
  if (!parseYmd(date)) throw new UserError('Neispravan datum.');
  const settings = await getSettings();
  const services = await resolveServices(serviceIds);
  const { duration, step } = combine(services);
  const holiday = closedHolidays(settings, date, date)[date];
  const busy = (await busyMap({ query: q }, date, date))[date] || [];
  const extra = (await extraMap({ query: q }, date, date))[date] || [];
  return daySlots({ date, hours: hoursFor(settings, holiday), duration, step, busy, extra, rules: settings.rules });
}

/** Za kalendar: koji dani u idućih N dana imaju barem jedan slobodan termin. */
export async function availableDays(serviceIds) {
  const settings = await getSettings();
  const services = await resolveServices(serviceIds);
  const { duration, step } = combine(services);
  const now = nowLocal();
  const to = addDays(now.date, settings.rules.maxDaysAhead);
  const map = await busyMap({ query: q }, now.date, to);
  const extras = await extraMap({ query: q }, now.date, to);
  const holidays = closedHolidays(settings, now.date, to);
  const days = {};
  for (let i = 0; i <= settings.rules.maxDaysAhead; i++) {
    const date = addDays(now.date, i);
    days[date] = daySlots({ date, hours: hoursFor(settings, holidays[date]), duration, step, busy: map[date] || [], extra: extras[date] || [], rules: settings.rules, now }).length;
  }
  return { from: now.date, to, days, holidays };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function cleanInput({ name, phone, email, note }, { requireContact = true } = {}) {
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  phone = String(phone || '').trim().slice(0, 30);
  email = String(email || '').trim().toLowerCase().slice(0, 120);
  note = String(note || '').trim().slice(0, 500);
  if (name.length < 2) throw new UserError('Upišite ime i prezime.');
  if (requireContact) {
    if ((phone.match(/\d/g) || []).length < 6) throw new UserError('Upišite ispravan broj mobitela.');
    if (!EMAIL_RE.test(email)) throw new UserError('Upišite ispravnu email adresu.');
  } else if (email && !EMAIL_RE.test(email)) {
    throw new UserError('Email adresa nije ispravna.');
  }
  return { name, phone, email, note };
}

/**
 * Klijentica uz termin. Kad Barbara sama upisuje termin, klijentica se prepoznaje po imenu (broj i email
 * često nema). Online rezervacija prvo traži po emailu, a zatim po imenu klijentice koja još nema email.
 */
async function upsertClient(db, { name, phone, email }, { fromAdmin = false } = {}) {
  let found = null;
  if (email && !fromAdmin) found = (await db.query('SELECT id FROM clients WHERE lower(email) = $1 ORDER BY id LIMIT 1', [email])).rows[0];
  if (!found) {
    found = (await db.query(
      `SELECT id FROM clients WHERE lower(name) = lower($1) AND ($2 = '' OR email = '' OR lower(email) = $2) ORDER BY id LIMIT 1`,
      [name, fromAdmin ? '' : email]
    )).rows[0];
  }
  if (found) {
    await db.query(
      `UPDATE clients SET name = $2, phone = COALESCE(NULLIF($3, ''), phone), email = COALESCE(NULLIF($4, ''), email) WHERE id = $1`,
      [found.id, name, phone, email]
    );
    return found.id;
  }
  const r = await db.query('INSERT INTO clients (name, phone, email) VALUES ($1,$2,$3) RETURNING id', [name, phone, email]);
  return r.rows[0].id;
}

/**
 * Nova rezervacija.
 * fromAdmin: Barbara ručno upisuje (može izvan pravila, ali ne preko drugog termina).
 */
export async function createBooking(input, { fromAdmin = false } = {}) {
  const settings = await getSettings();
  const services = await resolveServices(input.services || [], { allowInactive: fromAdmin });
  const contact = cleanInput(input, { requireContact: !fromAdmin });
  // Barbarin vlastiti broj nije broj klijentice
  if (fromAdmin && contact.phone && phoneDigits(contact.phone) === phoneDigits(settings.business.phone)) contact.phone = '';
  if (!fromAdmin && !input.consent) throw new UserError('Za rezervaciju je potrebna privola za obradu podataka.');
  if (!fromAdmin && !settings.rules.allowMultiple && services.length > 1) throw new UserError('Moguće je odabrati jednu uslugu po rezervaciji.');

  const date = String(input.date || '');
  const start = toMin(String(input.time || ''));
  if (!parseYmd(date) || start == null) throw new UserError('Odaberite datum i vrijeme.');
  const holiday = !fromAdmin && closedHolidays(settings, date, date)[date];
  if (holiday && !((await extraMap({ query: q }, date, date))[date] || []).length) throw new UserError(`Taj dan salon ne radi (${holiday}). Odaberite drugi datum.`, 409);
  const { duration: baseDuration, price: basePrice, step } = combine(services);
  const duration = fromAdmin && input.duration ? Math.max(15, Math.min(600, Number(input.duration))) : baseDuration;
  const price = fromAdmin && input.price != null && input.price !== '' ? Number(input.price) : basePrice;

  const status = fromAdmin ? 'potvrdeno' : settings.rules.autoConfirm ? 'potvrdeno' : 'na_cekanju';

  const booking = await tx(async (db) => {
    // Zaključaj dan da dvije klijentice ne uzmu isti termin istovremeno
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bsb:' + date]);
    const busy = (await busyMap(db, date, date))[date] || [];
    if (fromAdmin) {
      const clash = busy.some((b) => start < b.end && b.start < start + duration);
      if (clash && !input.force) throw new UserError('U to vrijeme već postoji termin ili blokada.', 409);
    } else {
      const extra = (await extraMap(db, date, date))[date] || [];
      const free = daySlots({ date, hours: hoursFor(settings, holiday), duration, step, busy, extra, rules: settings.rules });
      if (!free.includes(start)) throw new UserError('Taj termin je upravo zauzet. Odaberite drugo vrijeme.', 409);
    }
    const clientId = await upsertClient(db, contact, { fromAdmin });
    const r = await db.query(
      `INSERT INTO bookings (token, client_id, name, phone, email, date, start_min, duration, services, total_price,
         note, status, source, consent_at, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [randomToken(), clientId, contact.name, contact.phone, contact.email, date, start, duration,
        JSON.stringify(services.map((s) => ({ id: s.id, name: s.name, category: s.category, price: s.price, duration: s.duration }))),
        price, contact.note, status, fromAdmin ? 'admin' : 'web', fromAdmin ? null : new Date(), status === 'potvrdeno' ? new Date() : null]
    );
    return rowToBooking(r.rows[0]);
  });

  // Emailovi (greške u slanju ne ruše rezervaciju)
  const biz = settings.business;
  const extra = clientMailExtra(booking, settings.rules);
  inBackground(booking.id, async () => {
    if (fromAdmin) {
      if (input.notify && booking.email) await sendBookingEmail('potvrden', booking, biz, { extra });
    } else if (status === 'potvrdeno') {
      await sendBookingEmail('potvrden', booking, biz, { extra });
      await sendBookingEmail('novi_zahtjev', booking, biz, { toAdmin: true, extra: { autoConfirmed: true } });
    } else {
      await sendBookingEmail('zaprimljen', booking, biz, { extra });
      await sendBookingEmail('novi_zahtjev', booking, biz, { toAdmin: true });
    }
  });
  inBackground(booking.id, () => emit('booked', booking, { fromAdmin }));
  return booking;
}

// Mailovi idu u pozadini: klijentica i Barbara dobiju odgovor odmah, a ishod slanja se zapisuje u email_log.
// Mailovi iste rezervacije idu redom (npr. „zaprimljen” uvijek prije „otkazan”).
const mailQueues = new Map();
function inBackground(bookingId, job) {
  const next = (mailQueues.get(bookingId) || Promise.resolve())
    .then(job)
    .catch((err) => console.error('[email greška]', err.message));
  mailQueues.set(bookingId, next);
  next.then(() => { if (mailQueues.get(bookingId) === next) mailQueues.delete(bookingId); });
}

export async function getBookingById(id) {
  const r = await q('SELECT * FROM bookings WHERE id = $1', [id]);
  return r.rows[0] ? rowToBooking(r.rows[0]) : null;
}

export async function getBookingByToken(token) {
  const r = await q('SELECT * FROM bookings WHERE token = $1', [String(token || '')]);
  return r.rows[0] ? rowToBooking(r.rows[0]) : null;
}

/** Može li klijentica sama otkazati (npr. najkasnije 24 h prije). */
export function canClientCancel(b, rules, now = nowLocal()) {
  if (!['na_cekanju', 'potvrdeno'].includes(b.status)) return false;
  const left = wallMinutes(b.date, b.start_min) - wallMinutes(now.date, now.min);
  return left >= rules.cancelHours * 60;
}

/** Za mailove klijentici: do kada smije sama otkazati i može li još sada. */
export function clientMailExtra(b, rules) {
  return { cancelHours: rules.cancelHours, canCancel: canClientCancel(b, rules) };
}

const TRANSITIONS = {
  potvrdeno: ['na_cekanju', 'odbijeno', 'otkazano', 'nije_dosla'],
  odbijeno: ['na_cekanju'],
  otkazano: ['na_cekanju', 'potvrdeno'],
  nije_dosla: ['potvrdeno'],
  na_cekanju: ['odbijeno', 'otkazano'],
};

/** Promjena statusa (administracija ili klijentica). */
// onlyFrom: dopušteni početni statusi (npr. link iz emaila smije potvrditi samo zahtjev na čekanju)
export async function changeStatus(id, status, { notify = true, byClient = false, onlyFrom = null } = {}) {
  const settings = await getSettings();
  const updated = await tx(async (db) => {
    const cur = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new UserError('Rezervacija ne postoji.', 404);
    if (onlyFrom && !onlyFrom.includes(cur.status)) throw new UserError(`Već obrađeno – status: ${STATUS_LABEL[cur.status]}.`, 409);
    if (cur.status === status) return { booking: rowToBooking(cur), changed: false };
    if (!(TRANSITIONS[status] || []).includes(cur.status)) {
      throw new UserError(`Rezervacija je već: ${STATUS_LABEL[cur.status]}.`, 409);
    }
    // Vraćanje u aktivni status – provjeri da termin nije u međuvremenu zauzet
    if (['potvrdeno', 'na_cekanju'].includes(status) && !['potvrdeno', 'na_cekanju', 'nije_dosla'].includes(cur.status)) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bsb:' + cur.date]);
      const busy = (await busyMap(db, cur.date, cur.date, { excludeId: cur.id }))[cur.date] || [];
      if (busy.some((b) => cur.start_min < b.end && b.start < cur.start_min + cur.duration)) {
        throw new UserError('Taj termin je u međuvremenu zauzet.', 409);
      }
    }
    const r = await db.query(
      `UPDATE bookings SET status = $2,
         confirmed_at = CASE WHEN $2 = 'potvrdeno' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END,
         cancelled_at = CASE WHEN $2 IN ('otkazano','odbijeno') THEN now() ELSE cancelled_at END,
         cancelled_by = CASE WHEN $2 IN ('otkazano','odbijeno') THEN $3 ELSE cancelled_by END
       WHERE id = $1 RETURNING *`,
      [id, status, byClient ? 'klijentica' : 'salon']
    );
    return { booking: rowToBooking(r.rows[0]), changed: true, prev: cur.status };
  });

  const { booking, changed } = updated;
  if (changed && BUSY_STATUSES.includes(updated.prev) && !BUSY_STATUSES.includes(status)) {
    inBackground(booking.id, () => emit('slotFreed', booking.date));
  }
  if (changed && byClient && status === 'otkazano') inBackground(booking.id, () => emit('clientCancelled', booking));
  if (changed && notify) {
    const biz = settings.business;
    inBackground(booking.id, async () => {
      if (status === 'potvrdeno' && updated.prev !== 'nije_dosla') await sendBookingEmail('potvrden', booking, biz, { extra: clientMailExtra(booking, settings.rules) });
      if (status === 'odbijeno') await sendBookingEmail('odbijen', booking, biz);
      if (status === 'otkazano') {
        await sendBookingEmail('otkazan', booking, biz);
        if (byClient) await sendBookingEmail('otkazan_admin', booking, biz, { toAdmin: true });
      }
    });
  }
  return booking;
}

/** Barbara mijenja termin (datum, vrijeme, trajanje, cijenu, bilješku). */
export async function updateBooking(id, input, { notify = false } = {}) {
  const settings = await getSettings();
  const { booking, moved, oldDate } = await tx(async (db) => {
    const cur = (await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new UserError('Rezervacija ne postoji.', 404);
    const date = input.date ?? cur.date;
    const start = input.time != null ? toMin(String(input.time)) : cur.start_min;
    const duration = input.duration != null ? Math.max(15, Math.min(600, Number(input.duration))) : cur.duration;
    if (!parseYmd(date) || start == null || !Number.isFinite(duration)) throw new UserError('Neispravan datum ili vrijeme.');
    const moved = date !== cur.date || start !== cur.start_min || duration !== cur.duration;
    if (moved && BUSY_STATUSES.includes(cur.status)) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bsb:' + date]);
      const busy = (await busyMap(db, date, date, { excludeId: cur.id }))[date] || [];
      if (busy.some((b) => start < b.end && b.start < start + duration) && !input.force) {
        throw new UserError('U to vrijeme već postoji termin ili blokada.', 409);
      }
    }
    const price = input.price != null && input.price !== '' ? Number(input.price) : Number(cur.total_price);
    const r = await db.query(
      `UPDATE bookings SET date = $2, start_min = $3, duration = $4, total_price = $5, admin_note = $6,
         reminder_sent_at = CASE WHEN $7 THEN NULL ELSE reminder_sent_at END
       WHERE id = $1 RETURNING *`,
      [id, date, start, duration, price, input.admin_note != null ? String(input.admin_note).slice(0, 1000) : cur.admin_note, moved]
    );
    return { booking: rowToBooking(r.rows[0]), moved: moved && BUSY_STATUSES.includes(cur.status), oldDate: cur.date };
  });
  if (moved) inBackground(booking.id, () => emit('slotFreed', oldDate));
  if (moved && notify && booking.status === 'potvrdeno') {
    inBackground(booking.id, () => sendBookingEmail('promijenjen', booking, settings.business, { extra: clientMailExtra(booking, settings.rules) }));
  }
  return booking;
}
