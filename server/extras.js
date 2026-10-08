// Rute i veze za dodatne mogućnosti (obavijesti, sigurnosna kopija, lista čekanja …).
// Svaka se pali/gasi u Postavkama → Dodatne mogućnosti (settings.features).
import express from 'express';
import { hooks } from './hooks.js';
import { formatDateHr, toHHMM, nowLocal, addDays, diffDays } from './time.js';
import { UserError } from './bookings.js';
import { publicKey, saveSubscription, listDevices, removeDevice, notifyAdmin } from './push.js';
import { buildBackup, backupFiles, sendBackup } from './backup.js';
import { addToWaitlist, checkWaitlist, markBooked, leaveWaitlist, adminWaitlist, removeFromWaitlist } from './waitlist.js';
import { q, getSettings, getSecret, setSecret } from './db.js';
import { randomToken } from './auth.js';
import { calendarFeedIcs } from './ics.js';
import { baseUrl } from './email.js';
import { HOLIDAYS, holidaysForYear } from './holidays.js';
import { rebookOptOut } from './rebook.js';
import { getBookingByToken, rowToBooking } from './bookings.js';
import { addInquiry, adminInquiries, updateInquiry, requestDeposit, depositPaid } from './inquiries.js';
import { orderVoucher, markPaid, createInSalon, adminVouchers, findVoucher, redeem, cancelVoucher, voucherByToken } from './vouchers.js';
import { canReview, reviewFor, saveReview, adminReviews, setReviewStatus, shortName } from './reviews.js';

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

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = (n) => `${Number(n).toLocaleString('hr-HR')}\u00a0KM`;
const feature = async (k) => Boolean((await getSettings()).features[k]);
const calendarToken = () => getSecret('calendar_token', () => randomToken());

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

  // ---------- kalendar na mobitelu (pretplata) ----------
  app.get('/kalendar/:token.ics', wrap(async (req, res) => {
    const token = await calendarToken();
    if (!(await feature('calendarFeed')) || req.params.token !== token) return res.status(404).send('Nije pronađeno');
    const from = addDays(nowLocal().date, -60);
    const [bookings, blocks, settings] = await Promise.all([
      q(`SELECT * FROM bookings WHERE date >= $1 AND status IN ('potvrdeno','na_cekanju') ORDER BY date, start_min`, [from]),
      q('SELECT * FROM blocks WHERE date >= $1 ORDER BY date', [from]),
      getSettings(),
    ]);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(calendarFeedIcs({ bookings: bookings.rows.map(rowToBooking), blocks: blocks.rows, business: settings.business, baseUrl: baseUrl() }));
  }));
  const calendarUrls = (token) => {
    const url = `${baseUrl()}/kalendar/${token}.ics`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:') };
  };
  admin.get('/calendar', wrap(async (req, res) => res.json(calendarUrls(await calendarToken()))));
  admin.post('/calendar/reset', wrap(async (req, res) => {
    const token = randomToken();
    await setSecret('calendar_token', token);
    res.json(calendarUrls(token));
  }));

  // ---------- praznici ----------
  admin.get('/holidays', wrap(async (req, res) => {
    const today = nowLocal().date;
    const year = Number(today.slice(0, 4));
    const upcoming = [...holidaysForYear(year), ...holidaysForYear(year + 1)].filter((h) => h.date >= today);
    // Sljedeći put kad je praznik (Nova godina i Praznik rada traju dva dana)
    res.json(HOLIDAYS.map((h) => {
      const mine = upcoming.filter((x) => x.k === h.k);
      return { k: h.k, name: h.name, dates: mine.filter((x) => diffDays(mine[0].date, x.date) <= 3).map((x) => x.date) };
    }));
  }));

  // ---------- podsjetnik za novi termin ----------
  app.get('/podsjetnik/odjava/:token', wrap(async (req, res) => {
    const ok = await rebookOptOut(req.params.token);
    res.send(actionPage('Podsjetnici', ok
      ? '<h1>Odjavljeni ste</h1><p>Više vam nećemo slati podsjetnike za novi termin. Potvrde i podsjetnici za dogovorene termine i dalje stižu.</p><p><a class="btn btn-outline" href="/">Na početnu</a></p>'
      : '<h1>Link nije ispravan</h1><p><a class="btn btn-outline" href="/">Na početnu</a></p>'));
  }));

  // ---------- vjenčanja i svečanosti ----------
  app.post('/api/inquiries', rateLimit({ windowMs: 10 * 60_000, max: 5 }), wrap(async (req, res) => {
    if (req.body.website) return res.status(400).json({ error: 'Greška.' });
    res.status(201).json(await addInquiry(req.body));
  }));
  admin.get('/inquiries', wrap(async (req, res) => res.json(await adminInquiries())));
  admin.patch('/inquiries/:id', wrap(async (req, res) => res.json(await updateInquiry(Number(req.params.id), req.body))));
  admin.post('/inquiries/:id/deposit', wrap(async (req, res) => res.json(await requestDeposit(Number(req.params.id), req.body.deposit))));
  admin.post('/inquiries/:id/paid', wrap(async (req, res) => res.json(await depositPaid(Number(req.params.id), { notify: req.body.notify !== false }))));

  // ---------- poklon bonovi ----------
  app.post('/api/vouchers', rateLimit({ windowMs: 10 * 60_000, max: 5 }), wrap(async (req, res) => {
    if (req.body.website) return res.status(400).json({ error: 'Greška.' });
    res.status(201).json(await orderVoucher(req.body));
  }));
  app.get('/bon/:token', wrap(async (req, res) => {
    const v = await voucherByToken(req.params.token);
    if (!v || v.status === 'otkazan') return res.status(404).send(actionPage('Poklon bon', '<h1>Bon nije pronađen</h1><p><a class="btn btn-outline" href="/">Na početnu</a></p>'));
    res.send(voucherPage(v, (await getSettings()).business));
  }));
  admin.get('/vouchers', wrap(async (req, res) => res.json(await adminVouchers())));
  admin.post('/vouchers', wrap(async (req, res) => res.status(201).json(await createInSalon(req.body))));
  admin.get('/vouchers/find', wrap(async (req, res) => res.json(await findVoucher(req.query.code))));
  admin.post('/vouchers/redeem', wrap(async (req, res) => res.json(await redeem(req.body.code, req.body.amount, req.body.note))));
  admin.post('/vouchers/:id/paid', wrap(async (req, res) => res.json(await markPaid(Number(req.params.id), { notify: req.body.notify !== false }))));
  admin.delete('/vouchers/:id', wrap(async (req, res) => res.json(await cancelVoucher(Number(req.params.id)))));

  // ---------- recenzije ----------
  const reviewForm = (b, { error = '', rating = 0, text = '' } = {}) => actionPage('Ocijenite termin', `
    <h1>Kako vam se <em>svidjelo?</em></h1>
    <p class="action-info"><strong>${escHtml(b.services.map((s) => s.name).join(' + '))}</strong><br>${escHtml(formatDateHr(b.date))}</p>
    <form method="post" class="review-form">
      <fieldset class="stars"><legend class="sr-only">Ocjena</legend>
        ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}" ${rating === n ? 'checked' : ''}><label for="r${n}" title="${n} od 5">★</label>`).join('')}
      </fieldset>
      <div class="field"><label for="rv-text">Vaš dojam (nije obavezno)</label><textarea id="rv-text" name="text" maxlength="1000" placeholder="Što vam se svidjelo?">${escHtml(text)}</textarea></div>
      <p class="small muted">Na stranici se uz recenziju prikazuje samo ime i početno slovo prezimena (npr. ${escHtml(shortName(b.name))}), nakon što je Barbara pregleda.</p>
      ${error ? `<p class="error">${escHtml(error)}</p>` : ''}
      <button class="btn" type="submit">Pošalji ocjenu</button>
    </form>`);
  const reviewClosed = actionPage('Ocijenite termin', '<h1>Ocjenjivanje nije dostupno</h1><p>Za ovaj termin trenutno nije moguće ostaviti ocjenu.</p><p><a class="btn btn-outline" href="/">Na početnu</a></p>');
  const reviewThanks = actionPage('Hvala', '<h1>Hvala vam! 🤍</h1><p>Vaša ocjena je zaprimljena. Puno mi znači.</p><p><a class="btn btn-outline" href="/">Na početnu</a></p>');
  app.get('/recenzija/:token', wrap(async (req, res) => {
    const b = await getBookingByToken(req.params.token);
    if (!(await feature('reviews')) || !canReview(b)) return res.status(404).send(reviewClosed);
    const existing = await reviewFor(b.id);
    if (existing && existing.status !== 'nova') return res.send(reviewThanks);
    res.send(reviewForm(b, existing ? { rating: existing.rating, text: existing.text } : {}));
  }));
  app.post('/recenzija/:token', rateLimit({ windowMs: 10 * 60_000, max: 10 }), express.urlencoded({ extended: false }), wrap(async (req, res) => {
    const b = await getBookingByToken(req.params.token);
    if (!(await feature('reviews')) || !canReview(b)) return res.status(404).send(reviewClosed);
    const r = await saveReview(b, req.body);
    if (r.error) return res.status(400).send(reviewForm(b, { error: r.error, rating: Number(req.body.rating) || 0, text: req.body.text || '' }));
    res.send(reviewThanks);
  }));
  admin.get('/reviews', wrap(async (req, res) => res.json(await adminReviews())));
  admin.post('/reviews/:id/status', wrap(async (req, res) => {
    const r = await setReviewStatus(Number(req.params.id), req.body.status);
    if (!r) throw new UserError('Recenzija ne postoji.', 404);
    res.json(r);
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
  if ('voucherBankInfo' in input) next.voucherBankInfo = text(input.voucherBankInfo, 1000);
  if ('voucherAmounts' in input) {
    const list = (Array.isArray(input.voucherAmounts) ? input.voucherAmounts : String(input.voucherAmounts).split(/[,;\s]+/))
      .map(Number).filter((n) => Number.isFinite(n) && n >= 5 && n <= 2000);
    next.voucherAmounts = [...new Set(list)].sort((a, b) => a - b).slice(0, 6);
  }
  if ('voucherMonths' in input) next.voucherMonths = Math.min(36, Math.max(1, Math.round(Number(input.voucherMonths)) || 12));
  return next;
}

/** Poklon bon za ispis ili slanje dalje. */
function voucherPage(v, business) {
  const date = (d) => formatDateHr(d, { withDay: false });
  const state = v.status === 'naruceno' ? 'Bon još nije plaćen – postaje važeći čim ga Barbara označi kao plaćen.'
    : v.status === 'iskoristen' ? 'Ovaj bon je iskorišten.'
    : v.expired ? `Ovaj bon je istekao ${date(v.expires_on)}.` : '';
  const partly = v.status === 'aktivan' && v.balance < v.amount;
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Poklon bon – Barbara Skoko Beauty</title><meta name="robots" content="noindex"><link rel="icon" href="/assets/logo/favicon_32.png"><link rel="stylesheet" href="/css/style.css"></head>
<body class="voucher-page">
  ${state ? `<p class="voucher-state">${escHtml(state)}</p>` : ''}
  <main class="voucher${state ? ' void' : ''}">
    <img class="voucher-logo" src="/assets/logo/BSB_Horizontalni_logo_tamni.svg" alt="Barbara Skoko Beauty" width="190" height="60">
    <p class="label">Poklon bon</p>
    <p class="voucher-amount">${km(v.amount)}</p>
    ${v.recipient ? `<p class="voucher-for">za <em>${escHtml(v.recipient)}</em></p>` : ''}
    ${v.message ? `<p class="voucher-msg">„${escHtml(v.message)}”</p>` : ''}
    <div class="voucher-code"><span class="label">Kod</span><strong>${escHtml(v.code)}</strong></div>
    ${partly ? `<p class="small">Preostalo na bonu: <strong>${km(v.balance)}</strong></p>` : ''}
    <p class="small muted">${v.expires_on ? `Vrijedi do ${escHtml(date(v.expires_on))} za sve usluge u salonu.` : 'Vrijedi za sve usluge u salonu.'} Termin rezervirajte na ${escHtml(baseUrl().replace(/^https?:\/\//, ''))}/rezerviraj ili na ${escHtml(business.phone)}, a kod pokažite u salonu.</p>
    <p class="small muted">${escHtml([business.address, business.city].filter(Boolean).join(', '))} · ${escHtml(business.instagram || '')}</p>
  </main>
  <p class="voucher-actions"><button class="btn" onclick="window.print()">Ispiši bon</button> <a class="btn btn-outline" href="/rezerviraj">Rezervirajte termin</a></p>
</body></html>`;
}
