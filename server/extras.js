// Rute i veze za dodatne mogućnosti (obavijesti, sigurnosna kopija, lista čekanja …).
// Svaka se pali/gasi u Postavkama → Dodatne mogućnosti (settings.features).
import { hooks } from './hooks.js';
import { formatDateHr, toHHMM, nowLocal } from './time.js';
import { UserError } from './bookings.js';
import { publicKey, saveSubscription, listDevices, removeDevice, notifyAdmin } from './push.js';
import { buildBackup, backupFiles, sendBackup } from './backup.js';
import { addToWaitlist, checkWaitlist, markBooked, leaveWaitlist, adminWaitlist, removeFromWaitlist } from './waitlist.js';

const shortDate = (d) => formatDateHr(d).replace(/ \d{4}\.$/, '');
const names = (b) => b.services.map((s) => s.name).join(' + ');

// ---------- veze na događaje iz rezervacija ----------
hooks.on('booked', async (b, { fromAdmin }) => {
  await markBooked(b);
  if (fromAdmin) return;
  await notifyAdmin({
    title: b.status === 'potvrdeno' ? 'Nova rezervacija' : 'Novi zahtjev za termin',
    body: `${b.name} · ${shortDate(b.date)} u ${toHHMM(b.start_min)} · ${names(b)}`,
    url: '/admin#zahtjevi',
    tag: `b-${b.id}`,
  });
});
hooks.on('clientCancelled', (b) => notifyAdmin({
  title: 'Klijentica je otkazala termin',
  body: `${b.name} · ${shortDate(b.date)} u ${toHHMM(b.start_min)} · ${names(b)}`,
  url: '/admin#kalendar',
  tag: `b-${b.id}`,
}));
hooks.on('slotFreed', (date) => checkWaitlist(date));

export function registerExtras(app, admin, { wrap, rateLimit, actionPage }) {
  // ---------- lista čekanja (javno) ----------
  app.post('/api/waitlist', rateLimit({ windowMs: 10 * 60_000, max: 10 }), wrap(async (req, res) => {
    if (req.body.website) return res.status(400).json({ error: 'Greška.' });
    res.status(201).json(await addToWaitlist(req.body));
  }));
  app.get('/lista-cekanja/odjava/:token', wrap(async (req, res) => {
    const e = await leaveWaitlist(req.params.token);
    res.send(actionPage('Lista čekanja', e
      ? `<h1>Odjavljeni ste s liste čekanja</h1><p>Za ${shortDate(e.date)} više vam nećemo slati obavijesti.</p><p><a class="btn btn-outline" href="/#rezervacija">Rezervirajte drugi termin</a></p>`
      : '<h1>Upis nije pronađen</h1><p><a class="btn btn-outline" href="/">Na početnu</a></p>'));
  }));

  // ---------- lista čekanja (admin) ----------
  admin.get('/waitlist', wrap(async (req, res) => res.json(await adminWaitlist())));
  admin.delete('/waitlist/:id', wrap(async (req, res) => {
    await removeFromWaitlist(Number(req.params.id));
    res.json({ ok: true });
  }));

  // ---------- obavijesti na mobitel ----------
  admin.get('/push/key', wrap(async (req, res) => res.json({ key: await publicKey() })));
  admin.post('/push/subscribe', wrap(async (req, res) => {
    try {
      await saveSubscription(req.body.subscription, req.body.label);
    } catch (err) {
      throw new UserError(err.message);
    }
    res.json({ ok: true });
  }));
  admin.get('/push/devices', wrap(async (req, res) => res.json(await listDevices())));
  admin.delete('/push/devices/:id', wrap(async (req, res) => {
    await removeDevice(Number(req.params.id));
    res.json({ ok: true });
  }));
  admin.post('/push/test', wrap(async (req, res) => {
    const sent = await notifyAdmin({ title: 'Obavijesti rade 🤍', body: 'Ovako će izgledati obavijest o novom zahtjevu za termin.', url: '/admin', tag: 'test' }, { force: true });
    if (!sent) throw new UserError('Nijedan uređaj nije primio obavijest. Uključite obavijesti na ovom uređaju.');
    res.json({ sent });
  }));

  // ---------- sigurnosna kopija ----------
  admin.get('/backup.json', wrap(async (req, res) => {
    const data = await buildBackup();
    const [json] = backupFiles(data, nowLocal());
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${json.filename}"`);
    res.send(json.content);
  }));
  admin.post('/backup/send', wrap(async (req, res) => {
    if (!(await sendBackup())) throw new UserError('Kopija nije poslana – provjerite slanje emailova (Postavke → Email).');
    res.json({ ok: true });
  }));
}

/** Provjeri postavke dodatnih mogućnosti prije spremanja. */
export function cleanExtras(input, cur) {
  const next = { ...cur };
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  if ('holidays' in input) next.holidays = Array.isArray(input.holidays) ? input.holidays.map((x) => text(x, 40)).filter(Boolean) : null;
  if (input.rebookDays && typeof input.rebookDays === 'object') {
    next.rebookDays = {};
    for (const [cat, days] of Object.entries(input.rebookDays)) {
      const n = Math.round(Number(days));
      next.rebookDays[text(cat, 40)] = Number.isFinite(n) ? Math.min(365, Math.max(0, n)) : 0;
    }
  }
  if ('depositInfo' in input) next.depositInfo = text(input.depositInfo, 1000);
  if ('voucherPayment' in input) next.voucherPayment = text(input.voucherPayment, 500);
  if ('voucherAmounts' in input) {
    const list = (Array.isArray(input.voucherAmounts) ? input.voucherAmounts : String(input.voucherAmounts).split(/[,;\s]+/))
      .map(Number).filter((n) => Number.isFinite(n) && n >= 5 && n <= 2000);
    next.voucherAmounts = [...new Set(list)].sort((a, b) => a - b).slice(0, 6);
  }
  if ('voucherMonths' in input) next.voucherMonths = Math.min(36, Math.max(1, Math.round(Number(input.voucherMonths)) || 12));
  return next;
}
