// Lista čekanja: kad je dan pun, klijentica se upiše i dobije email čim se termin oslobodi.
import { q, getSettings } from './db.js';
import { randomToken } from './auth.js';
import { UserError, resolveServices, slotsFor, cleanInput } from './bookings.js';
import { nowLocal, addDays, dayOfWeek, parseYmd, formatDateHr, toHHMM } from './time.js';
import { buildCustom, sendRaw, baseUrl } from './email.js';
import { notifyAdmin } from './push.js';
import { closedHolidays } from './holidays.js';

export const PARTS = { bilo_kada: 'bilo kada', prijepodne: 'prijepodne (do 12 h)', poslijepodne: 'poslijepodne (od 12 h)' };
const ACTIVE = ['ceka', 'obavijestena'];

export const fitsPart = (min, part) => (part === 'prijepodne' ? min < 12 * 60 : part === 'poslijepodne' ? min >= 12 * 60 : true);

const shortDate = (d) => formatDateHr(d).replace(/ \d{4}\.$/, '');
const serviceNames = (e) => e.services.map((s) => s.name).join(' + ');
const bookLink = (e) => `${baseUrl()}/rezerviraj?usluga=${encodeURIComponent(e.services.map((s) => s.id).join(','))}&datum=${e.date}`;
const leaveLink = (e) => `${baseUrl()}/lista-cekanja/odjava/${e.token}`;

export async function addToWaitlist(input) {
  const settings = await getSettings();
  if (!settings.features.waitlist) throw new UserError('Lista čekanja trenutno nije dostupna.', 404);
  if (!input.consent) throw new UserError('Za upis je potrebna privola za obradu podataka.');
  const contact = cleanInput(input);
  const ids = Array.isArray(input.services) ? input.services : String(input.services || '').split(',');
  const services = await resolveServices(ids.map(String).filter(Boolean));
  const date = String(input.date || '');
  const now = nowLocal();
  if (!parseYmd(date) || date < now.date || date > addDays(now.date, settings.rules.maxDaysAhead)) throw new UserError('Odaberite datum unutar razdoblja za rezervacije.');
  if (!settings.hours[dayOfWeek(date)]) throw new UserError('Taj dan salon ne radi.');
  const holiday = closedHolidays(settings, date, date)[date];
  if (holiday) throw new UserError(`Taj dan salon ne radi (${holiday}).`);
  const part = PARTS[input.part] ? input.part : 'bilo_kada';
  const list = JSON.stringify(services.map((s) => ({ id: s.id, name: s.name })));

  // Ista klijentica za isti dan – samo osvježi upis
  const existing = (await q(`SELECT * FROM waitlist WHERE date = $1 AND lower(email) = $2 AND status = ANY($3)`, [date, contact.email, ACTIVE])).rows[0];
  const entry = existing
    ? (await q(`UPDATE waitlist SET name = $2, phone = $3, services = $4, part = $5, note = $6, status = 'ceka', notified_at = NULL WHERE id = $1 RETURNING *`,
      [existing.id, contact.name, contact.phone, list, part, contact.note])).rows[0]
    : (await q(`INSERT INTO waitlist (token, name, phone, email, services, date, part, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomToken(), contact.name, contact.phone, contact.email, list, date, part, contact.note])).rows[0];

  // Ako je termin u međuvremenu slobodan, odmah javi; inače potvrdi upis
  const free = await freeTimes(entry);
  const biz = settings.business;
  if (free.length) {
    await sendFreeEmail(entry, free, biz);
  } else {
    const mail = buildCustom('Upisani ste na listu čekanja', [
      `Bok ${entry.name.split(' ')[0]},`,
      'upisani ste na listu čekanja:',
      { box: [serviceNames(entry), `${shortDate(entry.date)} · ${PARTS[entry.part]}`] },
      'Čim se taj dan oslobodi termin, javit ću vam se emailom. Termin dobiva ona koja ga prva rezervira.',
      `Ako vam termin više ne treba, <a href="${leaveLink(entry)}">odjavite se s liste</a>.`,
      'Barbara',
    ], biz);
    await sendRaw({ to: entry.email, ...mail, kind: 'lista_cekanja' });
  }
  await notifyAdmin({
    title: 'Nova klijentica na listi čekanja',
    body: `${entry.name} · ${shortDate(entry.date)} · ${serviceNames(entry)}`,
    url: '/admin#zahtjevi',
    tag: `wl-${entry.id}`,
  });
  return { token: entry.token, free: free.map(toHHMM) };
}

/** Slobodna vremena za upis (poštuje doba dana i najkraći razmak do termina). */
async function freeTimes(entry) {
  try {
    return (await slotsFor(entry.services.map((s) => s.id), entry.date)).filter((m) => fitsPart(m, entry.part));
  } catch {
    return []; // npr. usluga je u međuvremenu ugašena
  }
}

async function sendFreeEmail(entry, free, biz) {
  const mail = buildCustom(`Oslobodio se termin · ${shortDate(entry.date)}`, [
    `Bok ${entry.name.split(' ')[0]},`,
    `dobre vijesti! Za ${shortDate(entry.date)} oslobodio se termin za ${serviceNames(entry)}.`,
    { box: [`Slobodno: ${free.slice(0, 8).map(toHHMM).join(', ')}`] },
    'Termin dobiva ona koja ga prva rezervira, pa ne čekajte predugo.',
    { button: 'Rezervirajte termin', href: bookLink(entry) },
    `Ako vam termin više ne treba, <a href="${leaveLink(entry)}">odjavite se s liste</a>.`,
    'Barbara',
  ], biz);
  await sendRaw({ to: entry.email, ...mail, kind: 'lista_slobodno' });
  await q(`UPDATE waitlist SET status = 'obavijestena', notified_at = now() WHERE id = $1`, [entry.id]);
}

/** Termin se oslobodio (otkazivanje, odbijanje, pomicanje, brisanje blokade) – javi onima koji čekaju taj dan. */
export async function checkWaitlist(date) {
  const settings = await getSettings();
  if (!settings.features.waitlist || !parseYmd(date) || date < nowLocal().date) return 0;
  // Ista klijentica dobije novi email tek 2 sata nakon prethodnog
  const { rows } = await q(
    `SELECT * FROM waitlist WHERE date = $1 AND status = ANY($2) AND email <> ''
       AND (notified_at IS NULL OR notified_at < now() - interval '2 hours') ORDER BY created_at`,
    [date, ACTIVE]
  );
  let sent = 0;
  for (const e of rows) {
    const free = await freeTimes(e);
    if (!free.length) continue;
    await sendFreeEmail(e, free, settings.business);
    sent++;
  }
  return sent;
}

/** Klijentica s liste je rezervirala taj dan – makni je s liste. */
export async function markBooked(b) {
  await q(
    `UPDATE waitlist SET status = 'rezervirala' WHERE date = $1 AND status = ANY($2) AND (lower(email) = lower($3) OR ($4 <> '' AND phone = $4))`,
    [b.date, ACTIVE, b.email || '-', b.phone || '']
  );
}

export async function leaveWaitlist(token) {
  const r = await q(`UPDATE waitlist SET status = 'odjavljena' WHERE token = $1 RETURNING *`, [String(token)]);
  return r.rows[0] || null;
}

export async function adminWaitlist() {
  const r = await q(
    `SELECT id, name, phone, email, services, date, part, note, status, created_at, notified_at FROM waitlist
     WHERE date >= $1 AND status = ANY($2) ORDER BY date, created_at`,
    [nowLocal().date, ACTIVE]
  );
  return r.rows;
}

export async function removeFromWaitlist(id) {
  await q(`UPDATE waitlist SET status = 'obrisana' WHERE id = $1`, [id]);
}
