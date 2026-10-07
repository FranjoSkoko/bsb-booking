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
  try {
    state.days = await api(`/api/days?services=${[...state.selected].join(',')}`);
    const first = state.date && state.days.days[state.date] ? state.date : Object.keys(state.days.days).find((d) => state.days.days[d] > 0);
    state.month = (first || state.days.from).slice(0, 7);
    renderCalendar();
    if (first) selectDate(first);
    else $('#slots-wrap').innerHTML = `<p class="empty">Trenutno nema slobodnih termina. Javite se na ${esc(state.config.business.phone)}.</p>`;
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
    const cls = ['cal-day', n ? 'avail' : '', ymd === state.date ? 'selected' : '', ymd === state.days.from ? 'today' : ''].join(' ');
    cells += `<button type="button" class="${cls}" data-date="${ymd}" ${n ? '' : 'disabled'} aria-label="${fmtDate(ymd)}${n ? '' : ', nema termina'}">${d}</button>`;
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
    <li>${icon('lokacija')}<a id="loc-link" target="_blank" rel="noopener">${esc([b.address, b.city].filter(Boolean).join(', '))}</a></li>`;
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
}

// Zadana fotografija za „O meni”; postavlja se tek kad se zna je li Barbara dodala svoju (da se ne učitaju obje)
const ABOUT_DEFAULT = '/assets/photos/barbara-o-meni.jpg';
function showAboutPhoto(src) {
  $('#about-photo').innerHTML = `<img src="${esc(src)}" alt="Barbara Skoko" width="1080" height="1350">`;
}

function renderGallery() {
  const items = state.config.gallery;
  const about = items.find((g) => g.caption === '#o-meni');
  showAboutPhoto(about ? `/api/gallery/${about.id}` : ABOUT_DEFAULT);
  const works = items.filter((g) => g.caption !== '#o-meni');
  if (!works.length) return;
  $('#radovi').hidden = false;
  $('[data-gallery-link]').hidden = false;
  $('#gallery').innerHTML = works.map((g) => `<figure><img src="/api/gallery/${g.id}" alt="${esc(g.caption || 'Rad Barbare Skoko')}" loading="lazy"></figure>`).join('');
}

// ---------- start ----------
(async () => {
  $('#year').textContent = new Date().getFullYear();
  try {
    state.config = await api('/api/config');
  } catch {
    $('#svc-list').innerHTML = $('#price-list').innerHTML = '<p class="error">Stranica se trenutno ne može učitati. Pokušajte ponovno za koju minutu.</p>';
    showAboutPhoto(ABOUT_DEFAULT);
    return;
  }
  if (state.config.rules.autoConfirm) $('#confirm-note').textContent = 'Termin se potvrđuje odmah, a potvrdu dobivate emailom.';
  $('#confirm-note').insertAdjacentHTML('afterend', `<p class="notice">${cancelRuleText()}</p>`);
  const pre = new URLSearchParams(location.search).get('usluga');
  if (pre && state.config.services.some((s) => s.id === pre)) state.selected.add(pre);
  renderPriceList();
  renderServices();
  renderContact();
  renderGallery();
  // Sadržaj iznad (cjenik) stigne tek sada, pa preglednik promaši #rezervacija iz linka – ponovi skok
  if (location.hash.length > 1) {
    try { document.querySelector(location.hash)?.scrollIntoView(); } catch { /* neispravan hash */ }
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
