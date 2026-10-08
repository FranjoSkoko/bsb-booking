import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, initDb, getSettings, saveSetting, getServices, tx } from './db.js';
import {
  UserError, createBooking, slotsFor, availableDays, getBookingByToken, getBookingById,
  changeStatus, canClientCancel, updateBooking, rowToBooking, STATUS_LABEL, hasStarted, clientMailExtra,
} from './bookings.js';
import { checkPassword, sessionCookie, clearSession, isAdmin, requireAdmin, verifyAction } from './auth.js';
import { bookingIcs } from './ics.js';
import { baseUrl, emailConfigured, buildEmail, sendRaw, adminEmail, icsAttachment } from './email.js';
import { runScheduledJobs, startScheduler } from './scheduler.js';
import { nowLocal, toHHMM, toMin, formatDateHr, parseYmd, addDays } from './time.js';
import { telHref, waHref } from './phone.js';
import { registerExtras, cleanExtras } from './extras.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { emit } from './hooks.js';
import { computeStats, chartMonths, monthlySeries, bookingsCsv } from './stats.js';
import { closedHolidays } from './holidays.js';
import { publicReviews } from './reviews.js';
import { EVENT_KINDS } from './inquiries.js';

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

// Railway pravu adresu posjetitelja šalje u X-Real-IP; prvi unos u X-Forwarded-For može izmisliti sam posjetitelj
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PUBLIC_DOMAIN);
const clientIp = (req) => (onRailway && req.get('x-real-ip')) || req.ip;

// Jednostavno ograničenje broja zahtjeva po IP adresi
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientIp(req);
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
  const qs = new URLSearchParams();
  for (const k of ['usluga', 'datum']) if (req.query[k]) qs.set(k, String(req.query[k]));
  res.redirect(302, `/${qs.size ? `?${qs}` : ''}#rezervacija`);
});
app.get('/rezervacija/:token', (req, res) => res.sendFile(path.join(PUBLIC, 'rezervacija.html')));
app.get('/privatnost', (req, res) => res.sendFile(path.join(PUBLIC, 'privatnost.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin', 'index.html')));

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, file) {
    if (/\.(png|jpe?g|webp|svg|ttf|woff2?)$/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
    else res.set('Cache-Control', 'no-cache');
  },
}));

// ---------- javni API ----------

const jsonSmall = express.json({ limit: '100kb' });
app.use('/api', (req, res, next) => (req.method === 'POST' && req.path.startsWith('/admin/gallery') ? next() : jsonSmall(req, res, next)));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', wrap(async (req, res) => {
  const settings = await getSettings();
  const services = await getServices({ onlyActive: true });
  const gallery = (await q('SELECT id, caption FROM gallery ORDER BY sort, id')).rows;
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
    features: {
      waitlist: settings.features.waitlist,
      events: settings.features.events,
      vouchers: settings.features.vouchers,
      reviews: settings.features.reviews,
      priceList: settings.features.priceList,
    },
    eventKinds: settings.features.events ? EVENT_KINDS : undefined,
    vouchers: settings.features.vouchers
      ? { amounts: settings.extras.voucherAmounts, payment: settings.extras.voucherPayment, months: settings.extras.voucherMonths }
      : undefined,
    reviews: settings.features.reviews ? await publicReviews() : undefined,
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

// Izmišljena rezervacija iz probnih emailova – njezini linkovi otvaraju primjer umjesto greške
const SAMPLE_TOKEN = 'primjer';
function sampleBooking(email = '') {
  return {
    id: 0, token: SAMPLE_TOKEN, name: 'Ana Anić', phone: '+387 63 000 000', email, date: addDays(nowLocal().date, 1),
    start_min: 10 * 60, duration: 60, services: [{ id: 'sminkanje', name: 'Šminkanje', price: 60, duration: 60 }], total_price: 60,
    note: 'Probna rezervacija', status: 'potvrdeno', status_label: STATUS_LABEL.potvrdeno,
  };
}
const loadBooking = (token) => (token === SAMPLE_TOKEN ? sampleBooking() : getBookingByToken(token));

async function publicBooking(b, settings) {
  const biz = settings.business;
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
    started: hasStarted(b),
    contact: { phone: biz.phone, tel: telHref(biz.phone), whatsapp: biz.whatsapp || waHref(biz.phone) },
    demo: b.token === SAMPLE_TOKEN,
  };
}

app.get('/api/bookings/:token', wrap(async (req, res) => {
  const b = await loadBooking(req.params.token);
  if (!b) return res.status(404).json({ error: 'Rezervacija nije pronađena.' });
  res.json(await publicBooking(b, await getSettings()));
}));

app.post('/api/bookings/:token/cancel', rateLimit({ windowMs: 10 * 60_000, max: 10 }), wrap(async (req, res) => {
  const settings = await getSettings();
  const b = await loadBooking(req.params.token);
  if (!b) return res.status(404).json({ error: 'Rezervacija nije pronađena.' });
  // Uz odbijenicu ide i trenutno stanje, da stranica (npr. stara kartica) prikaže stvarni status
  const refuse = async (error) => res.status(409).json({ error, booking: await publicBooking(b, settings) });
  if (b.token === SAMPLE_TOKEN) return refuse('Ovo je samo primjer iz probnog emaila – ništa nije otkazano.');
  const done = { otkazano: 'Termin je već otkazan.', odbijeno: 'Ovaj termin nije potvrđen.', nije_dosla: 'Termin je prošao.' }[b.status];
  if (done) return refuse(done);
  if (hasStarted(b)) return refuse('Termin je već prošao.');
  if (!canClientCancel(b, settings.rules)) {
    return refuse(`Termin se putem linka može otkazati najkasnije ${settings.rules.cancelHours} h prije. Javite se Barbari na ${settings.business.phone}.`);
  }
  const updated = await changeStatus(b.id, 'otkazano', { byClient: true });
  res.json(await publicBooking(updated, settings));
}));

app.get('/api/bookings/:token/ics', wrap(async (req, res) => {
  const b = await loadBooking(req.params.token);
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

const adminBtn = '<p><a class="btn btn-outline" href="/admin">Otvori administraciju</a></p>';
const demoActionPage = () => actionPage('Probni email', `<h1>Ovo je probni email</h1><p>U pravom emailu ovaj gumb potvrđuje ili odbija zahtjev za termin.</p>${adminBtn}`);
const bookingInfo = (booking) => `<p class="action-info"><strong>${escHtml(booking.services.map((x) => x.name).join(' + '))}</strong><br>${formatDateHr(booking.date)} u ${toHHMM(booking.start_min)}<br>${escHtml(booking.name)}${booking.phone ? ` · <a href="${telHref(booking.phone)}">${escHtml(booking.phone)}</a>` : ''}</p>`;
const startedPage = (booking) => actionPage('Termin je prošao', `<h1>Termin je već prošao</h1>${bookingInfo(booking)}<p>Ovaj zahtjev više se ne može potvrditi. Ako treba, promijenite ga u administraciji.</p>${adminBtn}`);

app.get('/admin/akcija', wrap(async (req, res) => {
  const { b, a, s } = req.query;
  if (!ACTIONS[a] || !verifyAction(b, a, s)) return res.status(403).send(actionPage('Neispravan link', `<h1>Link nije ispravan</h1>${adminBtn}`));
  if (Number(b) === 0) return res.send(demoActionPage());
  const booking = await getBookingById(Number(b));
  if (!booking) return res.status(404).send(actionPage('Nije pronađeno', `<h1>Rezervacija ne postoji</h1>${adminBtn}`));
  const info = bookingInfo(booking);
  if (booking.status !== 'na_cekanju') {
    return res.send(actionPage('Već obrađeno', `<h1>Status: ${booking.status_label}</h1>${info}${adminBtn}`));
  }
  if (a === 'potvrdi' && hasStarted(booking)) return res.send(startedPage(booking));
  // Gumb (POST) umjesto automatske promjene – da skeneri linkova u emailu ništa ne potvrde slučajno
  res.send(actionPage(a === 'potvrdi' ? 'Potvrda termina' : 'Odbijanje termina', `
    <h1>${a === 'potvrdi' ? 'Potvrditi termin?' : 'Odbiti termin?'}</h1>${info}
    <form method="post" action="/admin/akcija"><input type="hidden" name="b" value="${escHtml(b)}"><input type="hidden" name="a" value="${escHtml(a)}"><input type="hidden" name="s" value="${escHtml(s)}">
    <button class="btn" type="submit">${a === 'potvrdi' ? 'Potvrdi' : 'Odbij'}</button></form>
    <p><a href="/admin">Otvori administraciju</a></p>`));
}));

app.post('/admin/akcija', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const { b, a, s } = req.body;
  if (!ACTIONS[a] || !verifyAction(b, a, s)) return res.status(403).send(actionPage('Neispravan link', `<h1>Link nije ispravan</h1>${adminBtn}`));
  if (Number(b) === 0) return res.send(demoActionPage());
  try {
    const cur = await getBookingById(Number(b));
    if (cur && cur.status === 'na_cekanju' && a === 'potvrdi' && hasStarted(cur)) return res.send(startedPage(cur));
    // Samo zahtjev na čekanju – stari link ne smije vratiti termin koji je klijentica u međuvremenu otkazala
    const booking = await changeStatus(Number(b), ACTIONS[a], { onlyFrom: ['na_cekanju'] });
    const mail = !booking.email ? 'Klijentica nema email – javite joj se telefonom.'
      : a === 'potvrdi' ? 'Klijentica će dobiti email s potvrdom.' : 'Klijentica će dobiti email da odabere drugo vrijeme.';
    res.send(actionPage('Gotovo', `<h1>${booking.status_label}</h1><p>${mail}</p>${adminBtn}`));
  } catch (err) {
    if (err instanceof UserError) return res.status(err.status).send(actionPage('Već obrađeno', `<h1>${escHtml(err.message)}</h1>${adminBtn}`));
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
  const holidays = parseYmd(from) && parseYmd(to) ? closedHolidays(await getSettings(), from, to) : {};
  res.json({ bookings: r.rows.map(rowToBooking), blocks, holidays });
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

// Trajno brisanje termina (test ili greška) – više se ne vidi ni u kalendaru ni u analitici
admin.delete('/bookings/:id', wrap(async (req, res) => {
  const r = await tx(async (db) => {
    const del = await db.query('DELETE FROM bookings WHERE id = $1 RETURNING date, status, client_id', [Number(req.params.id)]);
    const b = del.rows[0];
    if (b?.client_id) {
      await db.query('DELETE FROM clients c WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM bookings WHERE client_id = c.id)', [b.client_id]);
    }
    return b;
  });
  if (r && ['na_cekanju', 'potvrdeno'].includes(r.status)) emit('slotFreed', r.date);
  res.json({ ok: true });
}));

admin.post('/blocks', wrap(async (req, res) => {
  const { date, dateTo, from, to, reason } = req.body;
  const open = Boolean(req.body.open);
  if (open && (!from || !to)) throw new UserError('Upišite od kada do kada su dodatni termini.');
  if (!parseYmd(date)) throw new UserError('Odaberite datum.');
  const last = dateTo && parseYmd(dateTo) ? dateTo : date;
  if (parseYmd(last) < parseYmd(date) || (parseYmd(last) - parseYmd(date)) / 86400000 > 366) throw new UserError('Neispravan raspon datuma.');
  const s = from ? toMin(from) : null;
  const e = to ? toMin(to) : null;
  if ((from || to) && (s == null || e == null || e <= s)) throw new UserError('Neispravno vrijeme blokade.');
  const created = [];
  for (let t = parseYmd(date); t <= parseYmd(last); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const r = await q('INSERT INTO blocks (date, start_min, end_min, reason, open) VALUES ($1,$2,$3,$4,$5) RETURNING *', [d, s, e, String(reason || '').slice(0, 200), open]);
    created.push(r.rows[0]);
    if (open) emit('slotFreed', d); // lista čekanja: možda je sad netko dobio termin
  }
  res.status(201).json(created);
}));

admin.delete('/blocks/:id', wrap(async (req, res) => {
  const r = await q('DELETE FROM blocks WHERE id = $1 RETURNING date, open', [Number(req.params.id)]);
  if (r.rowCount && !r.rows[0].open) emit('slotFreed', r.rows[0].date);
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
    // Linkovi na stranici i u mailovima moraju ostati ispravni kad Barbara promijeni ove podatke
    if ('instagram' in business && !('instagramUrl' in business)) {
      const handle = next.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
      if (handle) Object.assign(next, { instagram: `@${handle}`, instagramUrl: `https://www.instagram.com/${handle}/` });
    }
    if (next.whatsapp && !/^https?:\/\//i.test(next.whatsapp)) next.whatsapp = waHref(next.whatsapp);
    if (next.reviewUrl && !/^https?:\/\//i.test(next.reviewUrl)) throw new UserError('Link za recenzije mora počinjati s https://');
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
      if (h.breakFrom || h.breakTo) {
        const bf = toMin(h.breakFrom);
        const bt = toMin(h.breakTo);
        if (bf == null || bt == null || !(o < bf && bf < bt && bt < c)) throw new UserError('Provjerite pauzu: mora biti unutar radnog vremena.');
        Object.assign(next[d], { breakFrom: toHHMM(bf), breakTo: toHHMM(bt) });
      }
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
  if (req.body.features) {
    const next = { ...cur.features };
    for (const k of Object.keys(DEFAULT_SETTINGS.features)) if (k in req.body.features) next[k] = Boolean(req.body.features[k]);
    await saveSetting('features', next);
  }
  if (req.body.extras) await saveSetting('extras', cleanExtras(req.body.extras, cur.extras));
  res.json(await getSettings());
}));

// ---------- Analitika ----------
// Razdoblje: from/to (YYYY-MM-DD); bez njih – od prve do zadnje rezervacije.
async function statsRange(query) {
  const now = nowLocal();
  let { from, to } = query;
  if (!parseYmd(from) || !parseYmd(to)) {
    const span = (await q('SELECT min(date) AS a, max(date) AS b FROM bookings')).rows[0];
    from = parseYmd(from) ? from : span.a || now.date;
    to = parseYmd(to) ? to : [span.b, now.date].filter(Boolean).sort().at(-1);
  }
  if (to < from) throw new UserError('Neispravno razdoblje.');
  return { from, to, now };
}

admin.get('/stats', wrap(async (req, res) => {
  const { from, to, now } = await statsRange(req.query);
  const prev = parseYmd(req.query.prevFrom) && parseYmd(req.query.prevTo) ? { from: req.query.prevFrom, to: req.query.prevTo } : null;
  const months = chartMonths(from, to);
  const qFrom = [from, months[0] + '-01', prev?.from].filter(Boolean).sort()[0];
  const qTo = [to, months.at(-1) + '-31'].sort().at(-1);
  const settings = await getSettings();
  const [bookings, blocks, first, comeback] = await Promise.all([
    q('SELECT * FROM bookings WHERE date BETWEEN $1 AND $2', [qFrom, qTo]),
    q('SELECT date, start_min, end_min FROM blocks WHERE date BETWEEN $1 AND $2 AND NOT open', [from, to]),
    q(`SELECT client_id, min(date) AS d FROM bookings
       WHERE status = 'potvrdeno' AND client_id IS NOT NULL AND (date < $1 OR (date = $1 AND start_min <= $2))
       GROUP BY client_id`, [now.date, now.min]),
    // Klijentice koje nisu bile više od 6 tjedana i nemaju novi termin – vrijeme je za poruku
    q(`SELECT c.id, c.name, c.phone, max(b.date) AS last_date, count(*)::int AS visits,
         (SELECT x.services FROM bookings x WHERE x.client_id = c.id AND x.status = 'potvrdeno' AND x.date < $1
          ORDER BY x.date DESC, x.start_min DESC LIMIT 1) AS last_services
       FROM clients c JOIN bookings b ON b.client_id = c.id AND b.status = 'potvrdeno' AND b.date < $1
       WHERE NOT EXISTS (SELECT 1 FROM bookings u WHERE u.client_id = c.id AND u.status IN ('potvrdeno','na_cekanju') AND u.date >= $1)
       GROUP BY c.id HAVING max(b.date) <= $2
       ORDER BY count(*) DESC, max(b.date) DESC LIMIT 10`, [now.date, addDays(now.date, -42)]),
  ]);
  const rows = bookings.rows.map(rowToBooking);
  const firstVisit = Object.fromEntries(first.rows.map((r) => [r.client_id, r.d]));
  const common = { bookings: rows, now, rules: settings.rules, hours: settings.hours, firstVisit };
  const stats = computeStats({ ...common, from, to, blocks: blocks.rows });
  res.json({
    ...stats,
    today: now.date,
    previous: prev ? computeStats({ ...common, ...prev }).totals : null,
    months: monthlySeries(rows, months, now),
    comeback: comeback.rows.map((c) => ({
      id: c.id, name: c.name, last_date: c.last_date, visits: c.visits,
      last_services: (c.last_services || []).map((s) => s.name).join(' + '),
      tel: telHref(c.phone), whatsapp: waHref(c.phone),
    })),
  });
}));

admin.get('/stats.csv', wrap(async (req, res) => {
  const { from, to, now } = await statsRange(req.query);
  const r = await q('SELECT * FROM bookings WHERE date BETWEEN $1 AND $2 ORDER BY date, start_min', [from, to]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="bsb-termini-${from}-${to}.csv"`);
  res.send(bookingsCsv(r.rows.map(rowToBooking), now));
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
// ?termini=1: testna klijentica – obrišu se i svi njezini termini
admin.delete('/clients/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  await tx(async (db) => {
    if (req.query.termini === '1') await db.query('DELETE FROM bookings WHERE client_id = $1', [id]);
    else await db.query(`UPDATE bookings SET name = 'Obrisano', phone = '', email = '', note = '' WHERE client_id = $1`, [id]);
    await db.query('DELETE FROM reviews WHERE client_id = $1', [id]);
    await db.query('DELETE FROM clients WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

admin.post('/gallery', express.json({ limit: '12mb' }), wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(req.body.dataUrl || ''));
  if (!m) throw new UserError('Učitajte sliku (JPG, PNG ili WEBP).');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 8 * 1024 * 1024) throw new UserError('Slika je prevelika (najviše 8 MB).');
  const caption = String(req.body.caption || '').slice(0, 200);
  const row = await tx(async (db) => {
    // Za „O meni” postoji samo jedna fotografija – nova zamjenjuje staru
    if (caption === '#o-meni') await db.query(`DELETE FROM gallery WHERE caption = '#o-meni'`);
    return (await db.query('INSERT INTO gallery (mime, data, caption, sort) VALUES ($1,$2,$3,0) RETURNING id, caption', [m[1], data, caption])).rows[0];
  });
  res.status(201).json(row);
}));

// Par obrva (prije i poslije) sprema se zajedno; oba retka dijele ključ u opisu: #obrve:<ključ>:prije|poslije
const imageData = (url) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(url || ''));
  if (!m) throw new UserError('Učitajte obje fotografije (JPG, PNG ili WEBP).');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 8 * 1024 * 1024) throw new UserError('Fotografija je prevelika (najviše 8 MB).');
  return { mime: m[1], data };
};
admin.post('/gallery/pair', express.json({ limit: '24mb' }), wrap(async (req, res) => {
  const before = imageData(req.body.before);
  const after = imageData(req.body.after);
  const key = crypto.randomBytes(6).toString('hex');
  await tx(async (db) => {
    for (const [img, side] of [[before, 'prije'], [after, 'poslije']]) {
      await db.query('INSERT INTO gallery (mime, data, caption, sort) VALUES ($1,$2,$3,0)', [img.mime, img.data, `#obrve:${key}:${side}`]);
    }
  });
  res.status(201).json({ ok: true, key });
}));

admin.delete('/gallery/pair/:key', wrap(async (req, res) => {
  await q('DELETE FROM gallery WHERE caption LIKE $1', [`#obrve:${String(req.params.key).replace(/[^a-f0-9]/g, '')}:%`]);
  res.json({ ok: true });
}));

admin.delete('/gallery/:id', wrap(async (req, res) => {
  await q('DELETE FROM gallery WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

admin.get('/emails', wrap(async (req, res) => {
  res.json((await q('SELECT * FROM email_log ORDER BY id DESC LIMIT 100')).rows);
}));

// Probni emailovi – svih 9 predložaka s izmišljenom rezervacijom (sutra u 10:00)
admin.post('/test-email', wrap(async (req, res) => {
  const settings = await getSettings();
  const to = String(req.body.to || adminEmail(settings.business));
  const sample = sampleBooking(to);
  const extra = clientMailExtra(sample, settings.rules);
  const kinds = ['zaprimljen', 'novi_zahtjev', 'potvrden', 'podsjetnik', 'odbijen', 'otkazan', 'otkazan_admin', 'hvala', 'promijenjen'];
  let ok = 0;
  for (const kind of kinds) {
    const mail = buildEmail(kind, sample, settings.business, extra);
    const attachments = ['potvrden', 'promijenjen'].includes(kind) ? [icsAttachment(sample, settings.business)] : undefined;
    if (await sendRaw({ to, ...mail, attachments, subject: `[PROBA] ${mail.subject}`, kind: 'proba' })) ok++;
  }
  res.json({ sent: ok, total: kinds.length, to });
}));

admin.post('/run-jobs', wrap(async (req, res) => res.json(await runScheduledJobs())));

registerExtras(app, admin, { wrap, rateLimit, actionPage });
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
