import pg from 'pg';
import { DEFAULT_SERVICES, DEFAULT_SETTINGS } from './defaults.js';
import { phoneDigits } from './phone.js';

if (!process.env.DATABASE_URL) {
  console.error('\n[BSB] Nedostaje DATABASE_URL. Dodajte PostgreSQL bazu i varijablu DATABASE_URL (na Railwayu: ${{Postgres.DATABASE_URL}}).\n');
  process.exit(1);
}

// Neki hostani Postgresi (npr. Neon na Replitu) traže SSL.
const needsSsl = /sslmode=require|neon\.tech/.test(process.env.DATABASE_URL);
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(8,2) NOT NULL,
  duration INT NOT NULL,
  slot_step INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clients_email_idx ON clients (lower(email));
CREATE INDEX IF NOT EXISTS clients_phone_idx ON clients (phone);
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id INT REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_min INT NOT NULL,
  duration INT NOT NULL,
  services JSONB NOT NULL,
  total_price NUMERIC(8,2) NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  consent_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  thanks_sent_at TIMESTAMPTZ
);
-- Tko je otkazao: 'klijentica' ili 'salon' (za analitiku)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
-- Podsjetnik „vrijeme je za novi termin” (dodatna mogućnost)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rebook_sent_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rebook_optout BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings (date);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE TABLE IF NOT EXISTS blocks (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  start_min INT,
  end_min INT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocks_date_idx ON blocks (date);
-- open = TRUE: Barbara je za taj dan otvorila dodatne termine (izvan redovnog radnog vremena)
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS open BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS gallery (
  id SERIAL PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys JSONB NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  services JSONB NOT NULL,
  date TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT 'bilo_kada',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ceka',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS waitlist_date_idx ON waitlist (date);
CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'vjencanje',
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  ready_by TEXT NOT NULL DEFAULT '',
  people INT NOT NULL DEFAULT 1,
  location TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'novi',
  deposit NUMERIC(8,2),
  deposit_sent_at TIMESTAMPTZ,
  deposit_paid_at TIMESTAMPTZ,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vouchers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  amount NUMERIC(8,2) NOT NULL,
  balance NUMERIC(8,2) NOT NULL,
  buyer_name TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'naruceno',
  source TEXT NOT NULL DEFAULT 'web',
  expires_on TEXT,
  redemptions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
-- Kako kupac želi platiti bon: 'salon' (osobno u salonu) ili 'racun' (uplata na račun, podaci idu WhatsAppom)
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS payment TEXT NOT NULL DEFAULT 'salon';
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  booking_id INT UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  client_id INT REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  rating INT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  services TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nova',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  booking_id INT,
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initDb() {
  await q(SCHEMA);
  const { rows } = await q('SELECT count(*)::int AS n FROM services');
  if (rows[0].n === 0) {
    for (const [i, s] of DEFAULT_SERVICES.entries()) {
      await q(
        `INSERT INTO services (id, category, name, description, price, duration, slot_step, active, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)`,
        [s.id, s.category, s.name, s.description, s.price, s.duration, s.slot_step, i]
      );
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
  }
  // Staro zadano radno vrijeme (09–19, pon–sub) zamijeni novim s pauzom; ručno promijenjeno se ne dira
  const old = { open: '09:00', close: '19:00' };
  const oldHours = JSON.stringify({ 0: null, 1: old, 2: old, 3: old, 4: old, 5: old, 6: old });
  await q(`UPDATE settings SET value = $1 WHERE key = 'hours' AND value = $2::jsonb`, [JSON.stringify(DEFAULT_SETTINGS.hours), oldHours]);
  // Kontakt email je opet Gmail (info@ na domeni ostaje samo rezerva); ručno upisana druga adresa se ne dira
  await q(`UPDATE settings SET value = jsonb_set(value, '{email}', to_jsonb($1::text)) WHERE key = 'business' AND lower(value->>'email') = $2`,
    [DEFAULT_SETTINGS.business.email, 'info@barbaraskokobeauty.com']);
  await fixAdminClients();
}

/**
 * Ručno upisani termini s Barbarinim brojem spajali su se u jednu klijenticu (po broju).
 * Makni njen broj s termina i klijentica, a svaki takav termin veži uz klijenticu s istim imenom.
 */
async function fixAdminClients() {
  const own = phoneDigits((await getSettings()).business.phone);
  if (own) {
    for (const table of ['bookings', 'clients']) {
      const { rows } = await q(`SELECT id, phone FROM ${table} WHERE phone <> ''${table === 'bookings' ? " AND source = 'admin'" : ''}`);
      const ids = rows.filter((r) => phoneDigits(r.phone) === own).map((r) => r.id);
      if (ids.length) await q(`UPDATE ${table} SET phone = '' WHERE id = ANY($1)`, [ids]);
    }
  }
  const { rows } = await q(
    `SELECT b.id, b.name FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE b.source = 'admin' AND b.name <> 'Obrisano' AND lower(b.name) <> lower(c.name)`
  );
  for (const b of rows) {
    const found = (await q('SELECT id FROM clients WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [b.name])).rows[0];
    const id = found ? found.id : (await q('INSERT INTO clients (name) VALUES ($1) RETURNING id', [b.name])).rows[0].id;
    await q('UPDATE bookings SET client_id = $2 WHERE id = $1', [b.id, id]);
  }
}

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = { ...(out[r.key] || {}), ...r.value };
  // Prazna adresa ili lokacija za kartu → zadana vrijednost salona
  for (const k of ['address', 'mapQuery']) if (!out.business[k]) out.business[k] = DEFAULT_SETTINGS.business[k];
  // Raniji zadani tekst za kartu zamijeni točnim koordinatama
  if (out.business.mapQuery === 'Elbas Apartman, Ivana Zajca, Široki Brijeg') out.business.mapQuery = DEFAULT_SETTINGS.business.mapQuery;
  return out;
}

export async function saveSetting(key, value) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}

/** Dopuni „meta” (npr. kad je poslan pregled ili kopija) bez gaženja drugih polja. */
export async function updateMeta(patch) {
  await q(
    `INSERT INTO settings (key, value) VALUES ('meta', $1) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`,
    [JSON.stringify(patch)]
  );
}

/** Tajne vrijednosti (ključevi za obavijesti, link kalendara) – ne idu u postavke koje vidi preglednik. */
export async function getSecret(key, create) {
  const cur = await q('SELECT value FROM app_secrets WHERE key = $1', [key]);
  if (cur.rowCount || !create) return cur.rows[0]?.value ?? null;
  await q('INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(create())]);
  return (await q('SELECT value FROM app_secrets WHERE key = $1', [key])).rows[0].value;
}

export async function setSecret(key, value) {
  await q('INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}

export async function getServices({ onlyActive = false } = {}) {
  const { rows } = await q(
    `SELECT id, category, name, description, price::float AS price, duration, slot_step, active, sort
     FROM services ${onlyActive ? 'WHERE active' : ''} ORDER BY sort, name`
  );
  return rows;
}
