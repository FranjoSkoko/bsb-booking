// Javna stranica: cjenik, rezervacija u 3 koraka, galerija i kontakt.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = (n) => `${Number(n).toLocaleString('hr-HR')} KM`;

const DANI_KRATKO = ['Pon', 'Uto', 'Sri', 'Čet', 'Pet', 'Sub', 'Ned'];
const DANI = ['Nedjelja', 'Ponedjeljak', 'Utorak', 'Srijeda', 'Četvrtak', 'Petak', 'Subota'];
const MJESECI = ['siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj', 'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac'];
const MJESECI_GEN = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja', 'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca'];

const ymdParts = (s) => s.split('-').map(Number);
const dateObj = (s) => { const [y, m, d] = ymdParts(s); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDate = (s) => { const d = dateObj(s); return `${DANI[d.getUTCDay()]}, ${d.getUTCDate()}. ${MJESECI_GEN[d.getUTCMonth()]}`; };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Došlo je do greške. Pokušajte ponovno.');
  return data;
}

const state = { config: null, selected: new Set(), days: null, month: null, date: null, time: null };

function storage(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

// ---------- cjenik ----------
function groupByCategory(services) {
  const groups = new Map();
  for (const s of services) {
    if (!groups.has(s.category)) groups.set(s.category, []);
    groups.get(s.category).push(s);
  }
  return groups;
}

function renderPriceList() {
  const groups = groupByCategory(state.config.services);
  $('#price-list').innerHTML = [...groups].map(([cat, list]) => `
    <div class="price-cat">
      <span class="label">${esc(cat)}</span>
      ${list.map((s) => `
        <div class="price-row">
          <h3>${esc(s.name)}</h3><span class="price">${km(s.price)}</span>
          <span class="desc">${esc(s.description)}${s.description ? ' · ' : ''}${s.duration} min</span>
          <a class="book-link" href="#rezervacija" data-book="${esc(s.id)}">Rezervirajte</a>
        </div>`).join('')}
    </div>`).join('');
  $$('[data-book]').forEach((a) => a.addEventListener('click', () => {
    if (!state.config.rules.allowMultiple) state.selected.clear();
    state.selected.add(a.dataset.book);
    renderServices();
    goStep(1);
  }));
}

// ---------- korak 1: usluge ----------
function renderServices() {
  const multi = state.config.rules.allowMultiple;
  const groups = groupByCategory(state.config.services);
  $('#svc-list').innerHTML = [...groups].map(([cat, list]) => `
    <div class="svc-group">
      <span class="label">${esc(cat)}</span>
      ${list.map((s) => `
        <label class="svc">
          <input type="${multi ? 'checkbox' : 'radio'}" name="svc" value="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''}>
          <span><span class="name">${esc(s.name)}</span><span class="meta">${s.duration} min${s.description ? ' · ' + esc(s.description) : ''}</span></span>
          <span class="price">${km(s.price)}</span>
        </label>`).join('')}
    </div>`).join('') + (multi ? '<p class="notice">Možete odabrati više usluga – bit će jedna za drugom u istom terminu.</p>' : '');
  $$('#svc-list input').forEach((input) => input.addEventListener('change', () => {
    if (!multi) state.selected.clear();
    input.checked ? state.selected.add(input.value) : state.selected.delete(input.value);
    state.days = null; state.date = null; state.time = null;
    updateTotal();
  }));
  updateTotal();
}

function selectedServices() {
  return state.config.services.filter((s) => state.selected.has(s.id));
}

function totals() {
  const list = selectedServices();
  return {
    names: list.map((s) => s.name).join(' + '),
    price: list.reduce((a, s) => a + Number(s.price), 0),
    duration: list.reduce((a, s) => a + s.duration, 0),
  };
}

function updateTotal() {
  const t = totals();
  $('#svc-total').innerHTML = state.selected.size ? `Ukupno ${km(t.price)}<small>${t.duration} min</small>` : 'Odaberite uslugu';
  $('#to-step-2').disabled = !state.selected.size;
}

// ---------- koraci ----------
function goStep(step) {
  $$('.step-panel').forEach((p) => { p.hidden = p.dataset.panel !== String(step); });
  $$('#steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', String(n) === String(step));
    li.classList.toggle('done', step === 'done' || n < Number(step));
  });
  $('#steps').hidden = step === 'done';
  const top = $('#rezervacija').getBoundingClientRect().top + window.scrollY - 70;
  if (Math.abs(window.scrollY - top) > 200) window.scrollTo({ top, behavior: 'smooth' });
}

$('#to-step-2').addEventListener('click', async () => {
  goStep(2);
  await loadDays();
});
$('[data-panel="2"] [data-back]').addEventListener('click', () => { $('#wl-box').innerHTML = ''; });
$('#to-step-3').addEventListener('click', () => {
  const t = totals();
  $('#recap').innerHTML = `<div class="what">${esc(t.names)}</div><div class="when">${fmtDate(state.date)} u ${state.time} · ${t.duration} min · ${km(t.price)}</div>`;
  goStep(3);
  $('#f-name').focus({ preventScroll: true });
});
$$('[data-back]').forEach((b) => b.addEventListener('click', () => goStep(Number(b.dataset.back))));

// ---------- korak 2: kalendar i termini ----------
async function loadDays() {
  $('#cal').innerHTML = '<p class="empty">Tražim slobodne termine…</p>';
  $('#slots-wrap').innerHTML = '';
  renderWaitlistCta();
  try {
    state.days = await api(`/api/days?services=${[...state.selected].join(',')}`);
    // Traženi dan (npr. iz linka u emailu) je pun – ponudi listu čekanja za njega
    const wanted = state.date && state.days.days[state.date] === 0 ? state.date : null;
    const first = state.date && state.days.days[state.date] ? state.date : Object.keys(state.days.days).find((d) => state.days.days[d] > 0);
    state.month = (first || state.days.from).slice(0, 7);
    renderCalendar();
    if (first) await selectDate(first);
    else $('#slots-wrap').innerHTML = `<p class="empty">Trenutno nema slobodnih termina. Javite se na ${esc(state.config.business.phone)}.</p>`;
    const holiday = wanted && state.days.holidays?.[wanted];
    if (holiday) {
      $('#wl-box').innerHTML = `<p class="wl-cta"><strong>${esc(fmtDate(wanted))}</strong> je praznik (${esc(holiday)}) i salon ne radi.</p>`;
    } else if (wanted && state.config.features?.waitlist) {
      $('#wl-box').innerHTML = `<p class="wl-cta"><strong>${esc(fmtDate(wanted))}</strong> više nema slobodnih termina. <button type="button" class="btn-link" id="wl-open">Upišite se na listu čekanja za taj dan</button></p>`;
      $('#wl-open').addEventListener('click', () => openWaitlist(wanted));
    }
  } catch (err) {
    $('#cal').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function renderCalendar() {
  const [y, m] = state.month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7; // ponedjeljak prvi
  const minMonth = state.days.from.slice(0, 7);
  const maxMonth = state.days.to.slice(0, 7);
  let cells = DANI_KRATKO.map((d) => `<div class="dow">${d}</div>`).join('');
  cells += '<div></div>'.repeat(offset);
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${state.month}-${String(d).padStart(2, '0')}`;
    const n = state.days.days[ymd] || 0;
    const holiday = state.days.holidays?.[ymd];
    const cls = ['cal-day', n ? 'avail' : '', ymd === state.date ? 'selected' : '', ymd === state.days.from ? 'today' : ''].join(' ');
    cells += `<button type="button" class="${cls}" data-date="${ymd}" ${n ? '' : 'disabled'} aria-label="${fmtDate(ymd)}${holiday ? `, ${esc(holiday)}` : n ? '' : ', nema termina'}"${holiday ? ` title="${esc(holiday)}"` : ''}>${d}</button>`;
  }
  $('#cal').innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" data-dir="-1" ${state.month <= minMonth ? 'disabled' : ''} aria-label="Prethodni mjesec">‹</button>
      <h3>${MJESECI[m - 1]} ${y}.</h3>
      <button type="button" class="cal-nav" data-dir="1" ${state.month >= maxMonth ? 'disabled' : ''} aria-label="Sljedeći mjesec">›</button>
    </div>
    <div class="cal-grid">${cells}</div>`;
  $$('#cal [data-date]').forEach((b) => b.addEventListener('click', () => selectDate(b.dataset.date)));
  $$('#cal [data-dir]').forEach((b) => b.addEventListener('click', () => {
    const d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.dir), 1));
    state.month = d.toISOString().slice(0, 7);
    renderCalendar();
  }));
}

async function selectDate(date) {
  state.date = date;
  state.time = null;
  $('#to-step-3').disabled = true;
  if (date.slice(0, 7) !== state.month) state.month = date.slice(0, 7);
  renderCalendar();
  $('#slots-wrap').innerHTML = '<p class="empty">Učitavanje…</p>';
  try {
    const { slots } = await api(`/api/slots?services=${[...state.selected].join(',')}&date=${date}`);
    if (!slots.length) {
      $('#slots-wrap').innerHTML = '<p class="empty">Za ovaj dan više nema slobodnih termina.</p>';
      return;
    }
    $('#slots-wrap').innerHTML = `<p class="label slots-title">${fmtDate(date)}</p><div class="slots">${slots.map((t) => `<button type="button" class="slot" data-time="${t}">${t}</button>`).join('')}</div>`;
    $$('#slots-wrap .slot').forEach((b) => b.addEventListener('click', () => {
      state.time = b.dataset.time;
      $$('#slots-wrap .slot').forEach((x) => x.classList.toggle('selected', x === b));
      $('#to-step-3').disabled = false;
      $('#to-step-3').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  } catch (err) {
    $('#slots-wrap').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- lista čekanja ----------
function renderWaitlistCta() {
  if (!state.config.features?.waitlist) return;
  $('#wl-box').innerHTML = '<p class="wl-cta">Nema termina koji vam odgovara? <button type="button" class="btn-link" id="wl-open">Upišite se na listu čekanja</button></p>';
  $('#wl-open').addEventListener('click', () => openWaitlist());
}

function openWaitlist(wantedDate) {
  const today = state.config.today;
  const max = new Date(dateObj(today).getTime() + state.config.rules.maxDaysAhead * 86400000).toISOString().slice(0, 10);
  const c = storage('bsb_client') || {};
  const t = totals();
  $('#wl-box').innerHTML = `
    <form id="wl-form" class="form-grid wl-form" novalidate>
      <h3>Lista čekanja</h3>
      <p class="notice">Odaberite dan koji želite za ${esc(t.names)}. Čim se tog dana oslobodi termin, javit ćemo vam se emailom. Termin dobiva ona koja ga prva rezervira.</p>
      <div class="field"><label for="wl-date">Datum</label><input id="wl-date" type="date" min="${today}" max="${max}" value="${esc((typeof wantedDate === 'string' && wantedDate) || state.date || '')}" required></div>
      <div class="field"><label for="wl-part">Doba dana</label><select id="wl-part"><option value="bilo_kada">Bilo kada</option><option value="prijepodne">Prijepodne (do 12 h)</option><option value="poslijepodne">Poslijepodne (od 12 h)</option></select></div>
      <div class="field"><label for="wl-name">Ime i prezime</label><input id="wl-name" autocomplete="name" value="${esc(c.name || $('#f-name').value)}"></div>
      <div class="field"><label for="wl-phone">Broj mobitela</label><input id="wl-phone" type="tel" autocomplete="tel" inputmode="tel" value="${esc(c.phone || $('#f-phone').value)}"></div>
      <div class="field"><label for="wl-email">Email</label><input id="wl-email" type="email" autocomplete="email" inputmode="email" value="${esc(c.email || $('#f-email').value)}"></div>
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label class="check"><input type="checkbox" id="wl-consent"><span>Slažem se s obradom osobnih podataka radi obavijesti o slobodnom terminu. <a href="/privatnost" target="_blank">Više o privatnosti</a></span></label>
      <p class="error" id="wl-error" role="alert" hidden></p>
      <div class="step-actions">
        <button type="button" class="btn-link" id="wl-cancel">Odustani</button>
        <button class="btn" type="submit" id="wl-submit">Upišite me</button>
      </div>
    </form>`;
  $('#wl-cancel').addEventListener('click', renderWaitlistCta);
  $('#wl-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#wl-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#wl-error');
    err.hidden = true;
    const data = {
      services: [...state.selected], date: $('#wl-date').value, part: $('#wl-part').value,
      name: $('#wl-name').value, phone: $('#wl-phone').value, email: $('#wl-email').value,
      consent: $('#wl-consent').checked, website: e.target.elements.website.value,
    };
    const problem = !data.date ? 'Odaberite datum.' : !data.name.trim() ? 'Upišite ime i prezime.'
      : (data.phone.match(/\d/g) || []).length < 6 ? 'Upišite ispravan broj mobitela.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim()) ? 'Upišite ispravnu email adresu.'
      : !data.consent ? 'Za upis je potrebna privola za obradu podataka.' : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = $('#wl-submit');
    btn.disabled = true;
    try {
      const res = await api('/api/waitlist', { method: 'POST', body: JSON.stringify(data) });
      if (!storage('bsb_client')) storage('bsb_client', { name: data.name, phone: data.phone, email: data.email });
      $('#wl-box').innerHTML = res.free.length
        ? `<div class="wl-done"><p><strong>Dobre vijesti: ${esc(fmtDate(data.date).toLowerCase())} ima slobodnih termina</strong> (${esc(res.free.slice(0, 6).join(', '))}). Poslali smo vam ih i emailom.</p><button type="button" class="btn btn-small" id="wl-pick">Odaberite termin</button></div>`
        : `<div class="wl-done"><p><strong>Upisani ste na listu čekanja za ${esc(fmtDate(data.date).toLowerCase())}.</strong> Čim se termin oslobodi, javit ćemo vam se na ${esc(data.email)}.</p></div>`;
      $('#wl-pick')?.addEventListener('click', () => { state.date = data.date; loadDays(); });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------- korak 3: podaci i slanje ----------
const saved = storage('bsb_client');
if (saved) {
  $('#f-name').value = saved.name || '';
  $('#f-phone').value = saved.phone || '';
  $('#f-email').value = saved.email || '';
}

$('#booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#form-error');
  err.hidden = true;
  const data = {
    services: [...state.selected],
    date: state.date,
    time: state.time,
    name: $('#f-name').value,
    phone: $('#f-phone').value,
    email: $('#f-email').value,
    note: $('#f-note').value,
    consent: $('#f-consent').checked,
    website: f.elements.website.value,
  };
  const problem = !data.name.trim() ? 'Upišite ime i prezime.'
    : (data.phone.match(/\d/g) || []).length < 6 ? 'Upišite ispravan broj mobitela.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim()) ? 'Upišite ispravnu email adresu.'
    : !data.consent ? 'Za rezervaciju je potrebna privola za obradu podataka.' : null;
  if (problem) { err.textContent = problem; err.hidden = false; return; }

  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Šaljem…';
  try {
    const res = await api('/api/bookings', { method: 'POST', body: JSON.stringify(data) });
    storage('bsb_client', $('#f-remember').checked ? { name: data.name, phone: data.phone, email: data.email } : null);
    const list = storage('bsb_bookings') || [];
    storage('bsb_bookings', [res.token, ...list.filter((t) => t !== res.token)].slice(0, 10));
    showDone(res, data);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    if (/zauzet/.test(ex.message)) {
      setTimeout(() => { goStep(2); loadDays(); }, 1800);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pošaljite zahtjev';
  }
});

function showDone(res, data) {
  const t = totals();
  const confirmed = res.status === 'potvrdeno';
  $('#done-box').innerHTML = `
    <img src="/assets/icons/BSB_ikona_kvacica_tamna.png" alt="">
    <h3>${confirmed ? 'Vaš termin je potvrđen' : 'Hvala, zahtjev je poslan'}</h3>
    <div class="recap"><div class="what">${esc(t.names)}</div><div class="when">${fmtDate(data.date)} u ${data.time} · ${km(t.price)}</div></div>
    <p class="status-pill st-${res.status}">${esc(res.status_label)}</p>
    <p class="notice" style="margin-top:16px">${confirmed
      ? `Potvrda je poslana na ${esc(data.email)}.`
      : `Potvrdu zahtjeva poslali smo na ${esc(data.email)}. Termin je potvrđen kad vam Barbara odgovori emailom.`}</p>
    <p class="notice">${cancelRuleText()}</p>
    <div class="actions">
      <a class="btn" href="/rezervacija/${encodeURIComponent(res.token)}">Moja rezervacija</a>
      ${confirmed ? `<a class="btn btn-outline" href="/api/bookings/${encodeURIComponent(res.token)}/ics">Dodaj u kalendar</a>` : ''}
    </div>
    <p style="margin-top:20px"><button type="button" class="btn-link" id="new-booking">Nova rezervacija</button></p>`;
  $('#new-booking').addEventListener('click', () => { renderServices(); goStep(1); });
  state.selected.clear();
  state.date = null; state.time = null;
  goStep('done');
}

function cancelRuleText() {
  const h = state.config.rules.cancelHours;
  return `Termin možete sami otkazati putem linka iz emaila ${h > 0 ? `najkasnije ${h} h prije` : 'do početka termina'}, a nakon toga nazovite Barbaru ili joj pišite na WhatsApp.`;
}

// ---------- kontakt, galerija ----------
function renderContact() {
  const b = state.config.business;
  const tel = b.phone.replace(/[^\d+]/g, '');
  const icon = (n) => `<img src="/assets/icons/BSB_ikona_${n}_svijetla.png" alt="">`;
  $('#contact-list').innerHTML = `
    <li>${icon('telefon')}<a href="tel:${esc(tel)}">${esc(b.phone)}</a></li>
    <li>${icon('poruka')}<a href="${esc(b.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a></li>
    <li>${icon('info')}<a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>
    <li>${icon('srce')}<a href="${esc(b.instagramUrl)}" target="_blank" rel="noopener">${esc(b.instagram)}</a></li>
    <li>${icon('lokacija')}<a id="loc-link" data-route target="_blank" rel="noopener">${esc([b.address, b.city].filter(Boolean).join(', '))}</a></li>`;
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#hours').innerHTML = order.map((d) => {
    const h = state.config.hours[d];
    return `<tr><td>${DANI[d]}</td><td>${h ? `${h.open} – ${h.close}` : 'zatvoreno'}</td></tr>`;
  }).join('');
  const place = b.mapQuery || [b.address, b.city, 'Bosna i Hercegovina'].filter(Boolean).join(', ');
  const route = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`;
  $('#map').src = `https://maps.google.com/maps?q=${encodeURIComponent(place)}&z=17&hl=hr&output=embed`;
  $('#map-link').href = route;
  $('#route-btn').href = route;
  $('#loc-link').href = route;
  // Na iPhoneu se poveznica iz Instagrama ili s početnog zaslona otvara u pregledniku, koji zna samo približnu
  // lokaciju; zato se nudi izravno otvaranje aplikacije (Google Maps ili Apple Karte), koja koristi GPS.
  const dest = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(place) ? place.replace(/\s/g, '') : encodeURIComponent(place);
  state.maps = { web: route, google: `comgooglemaps://?daddr=${dest}&directionsmode=driving` };
  $('#mp-apple').href = `maps://?daddr=${dest}&dirflg=d`;
}

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function setupMapsPick() {
  const dlg = $('#maps-pick');
  document.addEventListener('click', (e) => {
    if (!IOS || !state.maps || !e.target.closest('[data-route]')) return;
    e.preventDefault();
    dlg.showModal();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('#mp-apple')) return dlg.close();
    if (e.target.closest('#mp-google')) {
      e.preventDefault();
      dlg.close();
      // ako aplikacija Google Maps nije instalirana, stranica ostaje vidljiva pa se otvara web verzija
      let left = false;
      const away = () => { left = true; };
      document.addEventListener('visibilitychange', away, { once: true });
      window.addEventListener('pagehide', away, { once: true });
      location.href = state.maps.google;
      setTimeout(() => { if (!left && !document.hidden) location.href = state.maps.web; }, 1500);
      return;
    }
    if (e.target === dlg || e.target.closest('.mp-cancel')) dlg.close();
  });
}

// Zadana fotografija za „O meni”; postavlja se tek kad se zna je li Barbara dodala svoju (da se ne učitaju obje)
const ABOUT_DEFAULT = '/assets/photos/barbara-o-meni.jpg?v=2';
function showAboutPhoto(src) {
  $('#about-photo').innerHTML = `<img src="${esc(src)}" alt="Barbara Skoko" width="1080" height="1350">`;
}

function renderGallery() {
  const items = state.config.gallery;
  const about = items.find((g) => g.caption === '#o-meni');
  showAboutPhoto(about ? `/api/gallery/${about.id}` : ABOUT_DEFAULT);
  // Fotografije koje Barbara doda u administraciji dolaze iza zadanih, pa se brojanje nastavlja
  const src = (g) => `/api/gallery/${g.id}`;
  const looks = items.filter((g) => !g.caption.startsWith('#')).map((g) => ({ src: src(g), alt: g.caption || 'Šminka – look' }));
  const pairs = {};
  for (const g of items) {
    const m = /^#obrve:([a-f0-9]+):(prije|poslije)$/.exec(g.caption);
    if (m) (pairs[m[1]] ||= {})[m[2] === 'prije' ? 'before' : 'after'] = src(g);
  }
  renderWorks(looks, Object.values(pairs).filter((p) => p.before && p.after));
}

// ---------- radovi: obrve prije i poslije, šminka i lookovi ----------
const W = '/assets/radovi/';
const BROWS = [
  { before: 'obrve-2-prije.jpg', after: 'obrve-2-poslije.jpg' },
];
const LOOKS = ['look-1.jpg', 'look-2.jpg', 'look-3.jpg', 'look-4.jpg'];
// Svaka sekcija ima svoj niz fotografija i svoje brojanje (1 / 2, 1 / 4 …)
let lbGroups = {};
let lbGroup = '';
let lbIndex = 0;

function workHtml(group, i, tag = '') {
  const item = lbGroups[group][i];
  return `<button type="button" class="work" data-work="${group}:${i}" aria-label="Povećaj: ${esc(item.alt)}">
    <img src="${esc(item.src)}" alt="${esc(item.alt)}" loading="lazy">${tag}</button>`;
}

// Koliko se radova vidi na početku i koliko ih dodaje svaki klik na „Prikaži više”
const SHOW_STEP = { obrve: 2, lookovi: 4 };

function renderWorks(lookUploads = [], browUploads = []) {
  const brows = [...BROWS.map((p) => ({ before: W + p.before, after: W + p.after })), ...browUploads];
  lbGroups = {
    obrve: brows.flatMap((p) => [
      { src: p.before, alt: 'Obrve prije oblikovanja', cap: 'Prije' },
      { src: p.after, alt: 'Obrve nakon oblikovanja', cap: 'Poslije' },
    ]),
    lookovi: [...LOOKS.map((f) => ({ src: W + f, alt: 'Šminka – look' })), ...lookUploads].map((it, n) => ({ ...it, alt: `${it.alt} ${n + 1}`, cap: '' })),
  };
  const hide = (group, n) => (n >= SHOW_STEP[group] ? ' hidden' : '');
  $('#ba-list').innerHTML = brows.map((_, n) => `<div class="ba"${hide('obrve', n)}>${workHtml('obrve', 2 * n, '<span class="tag">Prije</span>')}${workHtml('obrve', 2 * n + 1, '<span class="tag after">Poslije</span>')}</div>`).join('');
  $('#looks').innerHTML = lbGroups.lookovi.map((_, i) => workHtml('lookovi', i).replace('<button', `<button${hide('lookovi', i)}`)).join('');
  for (const [group, list] of [['obrve', '#ba-list'], ['lookovi', '#looks']]) {
    const btn = $(`[data-more="${group}"]`);
    btn.hidden = !$(`${list} > [hidden]`);
    btn.onclick = () => {
      $$(`${list} > [hidden]`).slice(0, SHOW_STEP[group]).forEach((el) => { el.hidden = false; });
      btn.hidden = !$(`${list} > [hidden]`);
    };
  }
}

function openLightbox(group, i) {
  const dlg = $('#lightbox');
  const list = lbGroups[group];
  lbGroup = group;
  lbIndex = (i + list.length) % list.length;
  const it = list[lbIndex];
  Object.assign($('#lb-img'), { src: it.src, alt: it.alt });
  $('#lb-cap').textContent = `${it.cap ? `${it.cap} · ` : ''}${lbIndex + 1} / ${list.length}`;
  if (!dlg.open) dlg.showModal();
}
const lbStep = (d) => openLightbox(lbGroup, lbIndex + d);

function setupLightbox() {
  const dlg = $('#lightbox');
  document.addEventListener('click', (e) => {
    const w = e.target.closest('[data-work]');
    if (!w) return;
    const [group, i] = w.dataset.work.split(':');
    openLightbox(group, Number(i));
  });
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lb]');
    if (b) return b.dataset.lb === 'close' ? dlg.close() : lbStep(Number(b.dataset.lb));
    if (e.target.tagName !== 'IMG') dlg.close(); // klik pokraj slike zatvara
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') lbStep(-1);
    if (e.key === 'ArrowRight') lbStep(1);
  });
  let x0 = null;
  dlg.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  dlg.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) lbStep(dx < 0 ? 1 : -1);
  });
}

// ---------- dodatne sekcije (uključuju se u administraciji) ----------
const EMAIL_OK = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
const contactProblem = (d) => (!d.name.trim() ? 'Upišite ime i prezime.'
  : (d.phone.match(/\d/g) || []).length < 6 ? 'Upišite ispravan broj mobitela.'
  : !EMAIL_OK(d.email) ? 'Upišite ispravnu email adresu.' : null);
const starsHtml = (n) => `<span class="stars-view" aria-label="${n} od 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;

// Pozadine dodatnih sekcija se izmjenjuju, da dvije susjedne nisu iste boje
function paintSections() {
  const bg = (el) => ['bg-cream', 'bg-sand', 'bg-dark'].find((c) => el.classList.contains(c)) || '';
  const list = $$('main > section').filter((el) => !el.hidden);
  list.forEach((el, i) => {
    if (!el.hasAttribute('data-alt')) return;
    el.classList.remove('bg-cream', 'bg-sand');
    const near = [bg(list[i - 1] || el), list[i + 1] ? bg(list[i + 1]) : ''];
    const pick = ['', 'bg-cream', 'bg-sand'].find((c) => !near.includes(c));
    if (pick) el.classList.add(pick);
  });
}

function prefill(prefix) {
  const c = storage('bsb_client') || {};
  for (const k of ['name', 'phone', 'email']) if (c[k] && !$(`#${prefix}-${k}`).value) $(`#${prefix}-${k}`).value = c[k];
}

function renderReviews() {
  const r = state.config.reviews;
  if (!state.config.features?.reviews || !r?.count) return;
  const withText = r.items.filter((x) => x.text);
  $('#rating-sum').innerHTML = `${starsHtml(Math.round(r.avg))} <strong>${r.avg.toLocaleString('hr-HR', { minimumFractionDigits: 1 })}</strong> · ${r.count} ${r.count % 10 === 1 && r.count % 100 !== 11 ? 'ocjena' : r.count % 10 >= 2 && r.count % 10 <= 4 && (r.count % 100 < 12 || r.count % 100 > 14) ? 'ocjene' : 'ocjena'}`;
  $('#reviews').innerHTML = withText.map((x) => `
    <figure class="review">
      ${starsHtml(x.rating)}
      <blockquote>${esc(x.text).replace(/\n/g, '<br>')}</blockquote>
      <figcaption>${esc(x.name)}${x.services ? ` <span>· ${esc(x.services)}</span>` : ''}</figcaption>
    </figure>`).join('');
  $('#dojmovi').hidden = false;
}

function renderVouchers() {
  const v = state.config.vouchers;
  if (!state.config.features?.vouchers || !v?.amounts?.length) return;
  $('#v-amounts').innerHTML = v.amounts.map((a, i) => `<label class="amount"><input type="radio" name="v-amount" value="${a}" ${i === Math.min(1, v.amounts.length - 1) ? 'checked' : ''}><span>${km(a)}</span></label>`).join('');
  $('#v-intro').textContent = `Bon vrijedi ${v.months} ${v.months % 10 === 1 && v.months !== 11 ? 'mjesec' : v.months % 10 >= 2 && v.months % 10 <= 4 && (v.months < 12 || v.months > 14) ? 'mjeseca' : 'mjeseci'} za sve usluge u salonu. Dobivate ga emailom, spreman za ispis ili za proslijediti.`;
  $('#v-payment').textContent = v.payment || '';
  $('#poklon-bon').hidden = false;
  $('[data-feature-link="vouchers"]').hidden = false;
  prefill('v');
  $('#voucher-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#v-error');
    err.hidden = true;
    const data = {
      amount: Number($('input[name="v-amount"]:checked')?.value), recipient: $('#v-recipient').value, message: $('#v-message').value,
      name: $('#v-name').value, phone: $('#v-phone').value, email: $('#v-email').value,
      consent: $('#v-consent').checked, website: e.target.elements.website.value,
    };
    const problem = !data.amount ? 'Odaberite iznos bona.' : contactProblem(data) || (!data.consent ? 'Za narudžbu je potrebna privola za obradu podataka.' : null);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = $('#v-submit');
    btn.disabled = true;
    try {
      await api('/api/vouchers', { method: 'POST', body: JSON.stringify(data) });
      e.target.hidden = true;
      $('#v-done').innerHTML = `<img src="/assets/icons/BSB_ikona_kvacica_tamna.png" alt="">
        <h3>Hvala, narudžba je poslana</h3>
        <p>Poklon bon ${esc(km(data.amount))}${data.recipient.trim() ? ` za ${esc(data.recipient.trim())}` : ''}. Potvrdu smo poslali na ${esc(data.email)}.</p>
        ${v.payment ? `<p class="notice">${esc(v.payment)}</p>` : ''}`;
      $('#v-done').hidden = false;
      $('#v-done').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

function renderEvents() {
  const kinds = state.config.eventKinds;
  if (!state.config.features?.events || !kinds) return;
  $('#e-kind').innerHTML = Object.entries(kinds).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  $('#e-date').min = state.config.today;
  $('#svecanosti').hidden = false;
  $('[data-feature-link="events"]').hidden = false;
  prefill('e');
  $('#event-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#e-error');
    err.hidden = true;
    const data = {
      kind: $('#e-kind').value, date: $('#e-date').value, readyBy: $('#e-ready').value, people: Number($('#e-people').value) || 1,
      location: $('#e-location').value, name: $('#e-name').value, phone: $('#e-phone').value, email: $('#e-email').value,
      note: $('#e-note').value, consent: $('#e-consent').checked, website: e.target.elements.website.value,
    };
    const problem = !data.date ? 'Odaberite datum svečanosti.' : data.date < state.config.today ? 'Datum je već prošao.'
      : contactProblem(data) || (!data.consent ? 'Za slanje upita potrebna je privola za obradu podataka.' : null);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = $('#e-submit');
    btn.disabled = true;
    try {
      await api('/api/inquiries', { method: 'POST', body: JSON.stringify(data) });
      e.target.hidden = true;
      $('#e-done').innerHTML = `<img src="/assets/icons/BSB_ikona_kvacica_tamna.png" alt="">
        <h3>Hvala, upit je poslan</h3>
        <p>${esc(kinds[data.kind])} · ${esc(fmtDate(data.date).toLowerCase())}. Potvrdu smo poslali na ${esc(data.email)}, a Barbara će vam se javiti da se dogovorite oko detalja.</p>`;
      $('#e-done').hidden = false;
      $('#e-done').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---------- start ----------
(async () => {
  $('#year').textContent = new Date().getFullYear();
  renderWorks();
  setupLightbox();
  setupMapsPick();
  try {
    state.config = await api('/api/config');
  } catch {
    $('#svc-list').innerHTML = $('#price-list').innerHTML = '<p class="error">Stranica se trenutno ne može učitati. Pokušajte ponovno za koju minutu.</p>';
    showAboutPhoto(ABOUT_DEFAULT);
    return;
  }
  if (state.config.rules.autoConfirm) $('#confirm-note').textContent = 'Termin se potvrđuje odmah, a potvrdu dobivate emailom.';
  $('#confirm-note').insertAdjacentHTML('afterend', `<p class="notice">${cancelRuleText()}</p>`);
  // Linkovi iz emailova: ?usluga=henna,classic&datum=2026-10-12
  const params = new URLSearchParams(location.search);
  for (const id of (params.get('usluga') || '').split(',')) {
    if (!state.config.services.some((s) => s.id === id)) continue;
    if (!state.config.rules.allowMultiple) state.selected.clear();
    state.selected.add(id);
  }
  const datum = params.get('datum');
  renderPriceList();
  if (state.config.features?.priceList) {
    $('#usluge').hidden = false;
    $('[data-feature-link="priceList"]').hidden = false;
    Object.assign($('#hero-second'), { href: '#usluge', textContent: 'Pogledajte usluge' });
  }
  renderServices();
  renderContact();
  renderGallery();
  renderReviews();
  renderVouchers();
  renderEvents();
  paintSections();
  if (state.selected.size && /^\d{4}-\d{2}-\d{2}$/.test(datum || '')) {
    state.date = datum;
    goStep(2);
    loadDays();
  }
  // Sadržaj iznad (cjenik) stigne tek sada, pa preglednik promaši #rezervacija iz linka – ponovi skok
  if (location.hash.length > 1) {
    try { document.querySelector(location.hash)?.scrollIntoView(); } catch { /* neispravan hash */ }
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
