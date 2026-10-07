import pg from 'pg';
import { DEFAULT_SERVICES, DEFAULT_SETTINGS } from './defaults.js';

if (!process.env.DATABASE_URL) {
  console.error('\n[BSB] Nedostaje DATABASE_URL. Na Replitu otvorite alat "Database" i dodajte PostgreSQL bazu.\n');
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
CREATE TABLE IF NOT EXISTS gallery (
  id SERIAL PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
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
}

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = { ...(out[r.key] || {}), ...r.value };
  // Prazna adresa ili lokacija za kartu → zadana vrijednost salona
  for (const k of ['address', 'mapQuery']) if (!out.business[k]) out.business[k] = DEFAULT_SETTINGS.business[k];
  return out;
}

export async function saveSetting(key, value) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
}

export async function getServices({ onlyActive = false } = {}) {
  const { rows } = await q(
    `SELECT id, category, name, description, price::float AS price, duration, slot_step, active, sort
     FROM services ${onlyActive ? 'WHERE active' : ''} ORDER BY sort, name`
  );
  return rows;
}
