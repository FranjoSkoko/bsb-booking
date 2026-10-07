import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, initDb, getSettings, saveSetting, getServices, tx } from './db.js';
import {
  UserError, createBooking, slotsFor, availableDays, getBookingByToken, getBookingById,
  changeStatus, canClientCancel, updateBooking, rowToBooking, STATUS_LABEL,
} from './bookings.js';
import { checkPassword, sessionCookie, clearSession, isAdmin, requireAdmin, verifyAction } from './auth.js';
import { bookingIcs } from './ics.js';
import { baseUrl, emailConfigured, buildEmail, sendRaw, adminEmail } from './email.js';
import { runScheduledJobs, startScheduler } from './scheduler.js';
import { nowLocal, toHHMM, toMin, formatDateHr, parseYmd } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Jednostavno ograničenje broja zahtjeva po IP adresi
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Previše pokušaja. Pokušajte ponovno za nekoliko minuta.' });
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

// ---------- stranice ----------

app.get(['/rezerviraj', '/r', '/booking'], (req, res) => {
  const usluga = req.query.usluga ? `?usluga=${encodeURIComponent(req.query.usluga)}` : '';
  res.redirect(302, `/${usluga}#rezervacija`);
});
app.get('/rezervacija/:token', (req, res) => res.sendFile(path.join(PUBLIC, 'rezervacija.html')));
app.get('/privatnost', (req, res) => res.sendFile(path.join(PUBLIC, 'privatnost.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin', 'index.html')));

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, file) {
    if (/\.(png|svg|ttf|woff2?)$/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
    else res.set('Cache-Control', 'no-cache');
  },
}));

// ---------- javni API ----------

const jsonSmall = express.json({ limit: '100kb' });
app.use('/api', (req, res, next) => (req.method === 'POST' && req.path === '/admin/gallery' ? next() : jsonSmall(req, res, next)));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', wrap(async (req, res) => {
  const settings = await getSettings();
  const services = await getServices({ onlyActive: true });
  const gallery = (await q('SELECT id, caption FROM gallery ORDER BY sort, id DESC')).rows;
  res.json({
    business: settings.business,
    hours: settings.hours,
    rules: {
      maxDaysAhead: settings.rules.maxDaysAhead,
      cancelHours: settings.rules.cancelHours,
      allowMultiple: settings.rules.allowMultiple,
      autoConfirm: settings.rules.autoConfirm,
    },
    services,
    gallery,
    today: nowLocal().date,
  });
}));

const parseIds = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

app.get('/api/days', wrap(async (req, res) => {
  res.json(await availableDays(parseIds(req.query.services)));
}));

app.get('/api/slots', wrap(async (req, res) => {
  const slots = await slotsFor(parseIds(req.query.services), String(req.query.date || ''));
  res.json({ date: req.query.date, slots: slots.map(toHHMM) });
}));

app.post('/api/bookings', rateLimit({ windowMs: 10 * 60_000, max: 20 }), wrap(async (req, res) => {
  if (req.body.website) return res.status(400).json({ error: 'Greška.' }); // zamka za botove
  const b = await createBooking(req.body);
  res.status(201).json({ token: b.token, status: b.status, status_label: b.status_label });
}));

async function publicBooking(b, settings) {
  return {
    token: b.token,
    name: b.name,
    date: b.date,
    date_label: formatDateHr(b.date),
    time: toHHMM(b.start_min),
    end: toHHMM(b.start_min + b.duration),
    duration: b.duration,
    services: b.services.map((s) => ({ name: s.name, category: s.category, price: s.price })),
    total_price: b.total_price,
    status: b.status,
    status_label: b.status_label,
    note: b.note,
    can_cancel: canClientCancel(b, settings.rules),
    cancel_hours: settings.rules.cancelHours,
  };
}

app.get('/api/bookings/:token', wrap(async (req, res) => {
  const b = await getBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'Rezervacija nije pronađena.' });
  res.json(await publicBooking(b, await getSettings()));
}));

app.post('/api/bookings/:token/cancel', rateLimit({ windowMs: 10 * 60_000, max: 10 }), wrap(async (req, res) => {
  const settings = await getSettings();
  const b = await getBookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: 'Rezervacija nije pronađena.' });
  if (!canClientCancel(b, settings.rules)) {
    throw new UserError(`Termin se putem linka može otkazati najkasnije ${settings.rules.cancelHours} h prije. Javite se Barbari na ${settings.business.phone}.`, 409);
  }
  const updated = await changeStatus(b.id, 'otkazano', { byClient: true });
  res.json(await publicBooking(updated, settings));
}));

app.get('/api/bookings/:token/ics', wrap(async (req, res) => {
  const b = await getBookingByToken(req.params.token);
  if (!b) return res.status(404).send('Nije pronađeno');
  const settings = await getSettings();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="termin-barbara-skoko-beauty.ics"');
  res.send(bookingIcs(b, settings.business, baseUrl()));
}));

app.get('/api/gallery/:id', wrap(async (req, res) => {
  const r = await q('SELECT mime, data FROM gallery WHERE id = $1', [Number(req.params.id) || 0]);
  if (!r.rowCount) return res.status(404).end();
  res.set('Content-Type', r.rows[0].mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(r.rows[0].data);
}));

// Za vanjski cron (npr. ako aplikacija "spava"): GET /api/cron?key=CRON_SECRET
app.get('/api/cron', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Zabranjeno' });
  res.json(await runScheduledJobs());
}));

// ---------- potvrda/odbijanje jednim dodirom iz emaila ----------

const ACTIONS = { potvrdi: 'potvrdeno', odbij: 'odbijeno' };

function actionPage(title, body) {
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} – Barbara Skoko Beauty</title><link rel="icon" href="/assets/logo/favicon_32.png"><link rel="stylesheet" href="/css/style.css"></head>
<body class="action-page"><main class="action-card"><img src="/assets/logo/BSB_Znak_u_krugu_tamni.svg" alt="" width="72" height="72">${body}</main></body></html>`;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/admin/akcija', wrap(async (req, res) => {
  const { b, a, s } = req.query;
  if (!ACTIONS[a] || !verifyAction(b, a, s)) return res.status(403).send(actionPage('Neispravan link', '<h1>Link nije ispravan</h1><p><a class="btn" href="/admin">Otvori administraciju</a></p>'));
  const booking = await getBookingById(Number(b));
  if (!booking) return res.status(404).send(actionPage('Nije pronađeno', '<h1>Rezervacija ne postoji</h1>'));
  const info = `<p class="action-info"><strong>${escHtml(booking.services.map((x) => x.name).join(' + '))}</strong><br>${formatDateHr(booking.date)} u ${toHHMM(booking.start_min)}<br>${escHtml(booking.name)} · ${escHtml(booking.phone)}</p>`;
  if (booking.status !== 'na_cekanju') {
    return res.send(actionPage('Već obrađeno', `<h1>Status: ${booking.status_label}</h1>${info}<p><a class="btn btn-outline" href="/admin">Otvori administraciju</a></p>`));
  }
  // Gumb (POST) umjesto automatske promjene – da skeneri linkova u emailu ništa ne potvrde slučajno
  res.send(actionPage(a === 'potvrdi' ? 'Potvrda termina' : 'Odbijanje termina', `
    <h1>${a === 'potvrdi' ? 'Potvrditi termin?' : 'Odbiti termin?'}</h1>${info}
    <form method="post" action="/admin/akcija"><input type="hidden" name="b" value="${escHtml(b)}"><input type="hidden" name="a" value="${escHtml(a)}"><input type="hidden" name="s" value="${escHtml(s)}">
    <button class="btn" type="submit">${a === 'potvrdi' ? 'Potvrdi' : 'Odbij'}</button></form>
    <p><a href="/admin">Otvori administraciju</a></p>`));
}));

app.post('/admin/akcija', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const { b, a, s } = req.body;
  if (!ACTIONS[a] || !verifyAction(b, a, s)) return res.status(403).send(actionPage('Neispravan link', '<h1>Link nije ispravan</h1>'));
  try {
    const booking = await changeStatus(Number(b), ACTIONS[a]);
    res.send(actionPage('Gotovo', `<h1>${booking.status_label}</h1><p>${a === 'potvrdi' ? 'Klijentica će dobiti email s potvrdom.' : 'Klijentica će dobiti email s prijedlogom novog termina.'}</p><p><a class="btn btn-outline" href="/admin">Otvori administraciju</a></p>`));
  } catch (err) {
    if (err instanceof UserError) return res.status(err.status).send(actionPage('Greška', `<h1>${escHtml(err.message)}</h1><p><a href="/admin">Otvori administraciju</a></p>`));
    throw err;
  }
}));

// ---------- administracija ----------

app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60_000, max: 10 }), (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD nije postavljen u Secrets.' });
  if (!checkPassword(String(req.body.password || ''))) return res.status(401).json({ error: 'Pogrešna lozinka.' });
  sessionCookie(res);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/status', wrap(async (req, res) => {
  res.json({
    emailConfigured: emailConfigured(),
    adminEmail: adminEmail((await getSettings()).business),
    baseUrl: baseUrl(),
    today: nowLocal().date,
  });
}));

admin.get('/bookings', wrap(async (req, res) => {
  const { from, to, status } = req.query;
  const params = [];
  const where = [];
  if (from) { params.push(from); where.push(`date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date <= $${params.length}`); }
  if (status) { params.push(String(status).split(',')); where.push(`status = ANY($${params.length})`); }
  const r = await q(`SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date, start_min LIMIT 1000`, params);
  const blocks = from && to ? (await q('SELECT * FROM blocks WHERE date BETWEEN $1 AND $2 ORDER BY date, start_min NULLS FIRST', [from, to])).rows : [];
  res.json({ bookings: r.rows.map(rowToBooking), blocks });
}));

admin.get('/pending', wrap(async (req, res) => {
  const r = await q(`SELECT * FROM bookings WHERE status = 'na_cekanju' ORDER BY date, start_min`);
  res.json(r.rows.map(rowToBooking));
}));

admin.post('/bookings', wrap(async (req, res) => {
  res.status(201).json(await createBooking(req.body, { fromAdmin: true }));
}));

admin.post('/bookings/:id/status', wrap(async (req, res) => {
  if (!STATUS_LABEL[req.body.status]) throw new UserError('Nepoznat status.');
  res.json(await changeStatus(Number(req.params.id), req.body.status, { notify: req.body.notify !== false }));
}));

admin.patch('/bookings/:id', wrap(async (req, res) => {
  res.json(await updateBooking(Number(req.params.id), req.body, { notify: Boolean(req.body.notify) }));
}));

admin.post('/blocks', wrap(async (req, res) => {
  const { date, dateTo, from, to, reason } = req.body;
  if (!parseYmd(date)) throw new UserError('Odaberite datum.');
  const last = dateTo && parseYmd(dateTo) ? dateTo : date;
  if (parseYmd(last) < parseYmd(date) || (parseYmd(last) - parseYmd(date)) / 86400000 > 366) throw new UserError('Neispravan raspon datuma.');
  const s = from ? toMin(from) : null;
  const e = to ? toMin(to) : null;
  if ((from || to) && (s == null || e == null || e <= s)) throw new UserError('Neispravno vrijeme blokade.');
  const created = [];
  for (let t = parseYmd(date); t <= parseYmd(last); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const r = await q('INSERT INTO blocks (date, start_min, end_min, reason) VALUES ($1,$2,$3,$4) RETURNING *', [d, s, e, String(reason || '').slice(0, 200)]);
    created.push(r.rows[0]);
  }
  res.status(201).json(created);
}));

admin.delete('/blocks/:id', wrap(async (req, res) => {
  await q('DELETE FROM blocks WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

admin.get('/services', wrap(async (req, res) => res.json(await getServices())));

admin.put('/services', wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (!list.length) throw new UserError('Popis usluga je prazan.');
  await tx(async (db) => {
    const ids = [];
    for (const [i, s] of list.entries()) {
      const id = String(s.id || s.name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `usluga-${i}`;
      const name = String(s.name || '').trim();
      const price = Number(s.price);
      const duration = Number(s.duration);
      const step = Number(s.slot_step) || 30;
      if (!name || !Number.isFinite(price) || price < 0 || !Number.isInteger(duration) || duration < 15 || duration > 600) {
        throw new UserError(`Provjerite uslugu "${name || i + 1}" (naziv, cijena, trajanje).`);
      }
      ids.push(id);
      await db.query(
        `INSERT INTO services (id, category, name, description, price, duration, slot_step, active, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET category=$2, name=$3, description=$4, price=$5, duration=$6, slot_step=$7, active=$8, sort=$9`,
        [id, String(s.category || 'BROWS').toUpperCase().trim(), name, String(s.description || '').trim(), price, duration, step, s.active !== false, i]
      );
    }
    await db.query('DELETE FROM services WHERE NOT (id = ANY($1))', [ids]);
  });
  res.json(await getServices());
}));

admin.get('/settings', wrap(async (req, res) => res.json(await getSettings())));

admin.put('/settings', wrap(async (req, res) => {
  const cur = await getSettings();
  const { business, hours, rules, notify } = req.body;
  if (business) {
    const allowed = ['name', 'owner', 'address', 'city', 'phone', 'whatsapp', 'email', 'instagram', 'instagramUrl', 'reviewUrl', 'mapQuery'];
    const next = { ...cur.business };
    for (const k of allowed) if (k in business) next[k] = String(business[k] ?? '').trim().slice(0, 300);
    await saveSetting('business', next);
  }
  if (hours) {
    const next = {};
    for (let d = 0; d < 7; d++) {
      const h = hours[d];
      if (!h) { next[d] = null; continue; }
      const o = toMin(h.open);
      const c = toMin(h.close);
      if (o == null || c == null || c <= o) throw new UserError('Provjerite radno vrijeme.');
      next[d] = { open: toHHMM(o), close: toHHMM(c) };
    }
    await saveSetting('hours', next);
  }
  if (rules) {
    const num = (v, min, max, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def);
    await saveSetting('rules', {
      minNoticeHours: num(rules.minNoticeHours, 0, 168, cur.rules.minNoticeHours),
      maxDaysAhead: num(rules.maxDaysAhead, 1, 365, cur.rules.maxDaysAhead),
      cancelHours: num(rules.cancelHours, 0, 168, cur.rules.cancelHours),
      bufferMin: num(rules.bufferMin, 0, 120, cur.rules.bufferMin),
      autoConfirm: Boolean(rules.autoConfirm),
      allowMultiple: Boolean(rules.allowMultiple),
    });
  }
  if (notify) {
    await saveSetting('notify', { reminders: Boolean(notify.reminders), thanks: Boolean(notify.thanks), dailySummary: Boolean(notify.dailySummary) });
  }
  res.json(await getSettings());
}));

admin.get('/clients', wrap(async (req, res) => {
  const search = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const r = await q(
    `SELECT c.*, count(b.id)::int AS visits,
       count(b.id) FILTER (WHERE b.status = 'nije_dosla')::int AS no_shows,
       max(b.date) FILTER (WHERE b.status IN ('potvrdeno','na_cekanju')) AS last_date,
       coalesce(sum(b.total_price) FILTER (WHERE b.status = 'potvrdeno'), 0)::float AS spent
     FROM clients c LEFT JOIN bookings b ON b.client_id = c.id
     WHERE lower(c.name) LIKE $1 OR lower(c.email) LIKE $1 OR c.phone LIKE $1
     GROUP BY c.id ORDER BY max(b.created_at) DESC NULLS LAST, c.name LIMIT 300`,
    [search]
  );
  res.json(r.rows);
}));

admin.get('/clients/:id', wrap(async (req, res) => {
  const c = await q('SELECT * FROM clients WHERE id = $1', [Number(req.params.id)]);
  if (!c.rowCount) throw new UserError('Klijentica ne postoji.', 404);
  const b = await q('SELECT * FROM bookings WHERE client_id = $1 ORDER BY date DESC, start_min DESC', [c.rows[0].id]);
  res.json({ ...c.rows[0], bookings: b.rows.map(rowToBooking) });
}));

admin.patch('/clients/:id', wrap(async (req, res) => {
  const { notes, name, phone, email } = req.body;
  const r = await q(
    `UPDATE clients SET notes = COALESCE($2, notes), name = COALESCE($3, name), phone = COALESCE($4, phone), email = COALESCE($5, email)
     WHERE id = $1 RETURNING *`,
    [Number(req.params.id), notes ?? null, name ?? null, phone ?? null, email ?? null]
  );
  res.json(r.rows[0]);
}));

// Brisanje podataka klijentice na zahtjev (GDPR)
admin.delete('/clients/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (db) => {
    await db.query(`UPDATE bookings SET name = 'Obrisano', phone = '', email = '', note = '' WHERE client_id = $1`, [id]);
    await db.query('DELETE FROM clients WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

admin.post('/gallery', express.json({ limit: '12mb' }), wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(req.body.dataUrl || ''));
  if (!m) throw new UserError('Učitajte sliku (JPG, PNG ili WEBP).');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 8 * 1024 * 1024) throw new UserError('Slika je prevelika (najviše 8 MB).');
  const r = await q('INSERT INTO gallery (mime, data, caption, sort) VALUES ($1,$2,$3,0) RETURNING id, caption', [m[1], data, String(req.body.caption || '').slice(0, 200)]);
  res.status(201).json(r.rows[0]);
}));

admin.delete('/gallery/:id', wrap(async (req, res) => {
  await q('DELETE FROM gallery WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

admin.get('/emails', wrap(async (req, res) => {
  res.json((await q('SELECT * FROM email_log ORDER BY id DESC LIMIT 100')).rows);
}));

// Probni emailovi – svih 8 predložaka s izmišljenom rezervacijom
admin.post('/test-email', wrap(async (req, res) => {
  const settings = await getSettings();
  const to = String(req.body.to || adminEmail(settings.business));
  const sample = {
    id: 0, token: 'primjer', name: 'Ana Anić', phone: '+387 63 000 000', email: to, date: nowLocal().date,
    start_min: 10 * 60, duration: 60, services: [{ name: 'Šminkanje', price: 60, duration: 60 }], total_price: 60, note: 'Probna rezervacija',
  };
  const kinds = ['zaprimljen', 'novi_zahtjev', 'potvrden', 'podsjetnik', 'odbijen', 'otkazan', 'hvala', 'promijenjen'];
  let ok = 0;
  for (const kind of kinds) {
    const mail = buildEmail(kind, sample, settings.business);
    if (await sendRaw({ to, ...mail, subject: `[PROBA] ${mail.subject}`, kind: 'proba' })) ok++;
  }
  res.json({ sent: ok, total: kinds.length, to });
}));

admin.post('/run-jobs', wrap(async (req, res) => res.json(await runScheduledJobs())));

app.use('/api/admin', admin);

// ---------- greške ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Nije pronađeno.' }));

app.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Datoteka je prevelika.' });
  console.error(err);
  res.status(500).json({ error: 'Došlo je do greške. Pokušajte ponovno.' });
});

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, '404.html')));

// ---------- pokretanje ----------

const PORT = Number(process.env.PORT || 3000);
await initDb();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BSB] Aplikacija radi na ${baseUrl()} (port ${PORT})`);
  if (!process.env.ADMIN_PASSWORD) console.warn('[BSB] Upozorenje: ADMIN_PASSWORD nije postavljen – administracija je zaključana.');
  if (Boolean(process.env.MAIL_RELAY_URL) !== Boolean(process.env.MAIL_RELAY_KEY)) {
    console.warn('[BSB] Upozorenje: za slanje preko Google skripte trebaju obje varijable, MAIL_RELAY_URL i MAIL_RELAY_KEY.');
  }
  if (!emailConfigured()) console.warn('[BSB] Upozorenje: slanje emailova nije podešeno (MAIL_RELAY_URL / MAIL_RELAY_KEY ili SMTP_USER / SMTP_PASS) – emailovi se ne šalju.');
});
if (process.env.DISABLE_SCHEDULER !== '1') startScheduler();
