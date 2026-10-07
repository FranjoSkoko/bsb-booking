// Sigurnosna kopija: svi podaci (bez slika) u jednoj JSON datoteci + termini za Excel.
import { q, getSettings, updateMeta } from './db.js';
import { nowLocal } from './time.js';
import { rowToBooking } from './bookings.js';
import { bookingsCsv } from './stats.js';
import { buildCustom, sendRaw, adminEmail, baseUrl } from './email.js';

// Redoslijed je bitan za vraćanje (klijentice prije termina)
const TABLES = ['settings', 'services', 'clients', 'bookings', 'blocks', 'waitlist', 'inquiries', 'vouchers', 'reviews'];

export async function buildBackup() {
  const tables = {};
  for (const t of TABLES) {
    const exists = (await q('SELECT to_regclass($1) AS t', [t])).rows[0].t;
    if (exists) tables[t] = (await q(`SELECT * FROM ${t} ORDER BY 1`)).rows;
  }
  // Fotografije su prevelike za email – samo popis
  tables.gallery = (await q('SELECT id, caption, mime, sort, created_at FROM gallery ORDER BY id')).rows;
  return { app: 'bsb-booking', version: 1, created_at: new Date().toISOString(), tables };
}

export function backupFiles(data, now = nowLocal()) {
  const bookings = (data.tables.bookings || []).map(rowToBooking).sort((a, b) => (a.date + a.start_min).localeCompare(b.date + b.start_min));
  return [
    { filename: `bsb-kopija-${now.date}.json`, content: JSON.stringify(data), contentType: 'application/json' },
    { filename: `bsb-termini-${now.date}.csv`, content: bookingsCsv(bookings, now), contentType: 'text/csv' },
  ];
}

/** Pošalji kopiju Barbari na email. */
export async function sendBackup() {
  const settings = await getSettings();
  const now = nowLocal();
  const data = await buildBackup();
  const n = (t) => (data.tables[t] || []).length;
  const mail = buildCustom(`Sigurnosna kopija podataka · ${now.date.split('-').reverse().join('.')}.`, [
    'Bok Barbara, u privitku je tjedna sigurnosna kopija svih podataka iz aplikacije za rezervacije.',
    { box: [`${n('bookings')} termina`, `${n('clients')} klijentica`, `${n('services')} usluga`] },
    'Datoteku .json spremite (npr. ostavite ovaj email u Gmailu). Ako se podaci ikad izgube, iz nje se sve može vratiti. Datoteka .csv otvara se u Excelu.',
    { button: 'Otvori administraciju', href: `${baseUrl()}/admin` },
  ], settings.business);
  const ok = await sendRaw({ to: adminEmail(settings.business), ...mail, attachments: backupFiles(data, now), kind: 'kopija' });
  if (ok) await updateMeta({ lastBackup: now.date });
  return ok;
}
