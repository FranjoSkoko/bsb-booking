// Administracija za Barbaru – radi i na mobitelu.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = (n) => `${Number(n).toLocaleString('hr-HR')} KM`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

const DANI = ['nedjelja', 'ponedjeljak', 'utorak', 'srijeda', 'četvrtak', 'petak', 'subota'];
const DANI_KR = ['Pon', 'Uto', 'Sri', 'Čet', 'Pet', 'Sub', 'Ned'];
const MJ = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja', 'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca'];
const MJ_NOM = ['siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj', 'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac'];
const STATUS = { na_cekanju: 'Na čekanju', potvrdeno: 'Potvrđeno', odbijeno: 'Odbijeno', otkazano: 'Otkazano', nije_dosla: 'Nije došla' };

const dObj = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(dObj(s).getTime() + n * 86400000));
const dow = (s) => dObj(s).getUTCDay();
const fmtDay = (s) => { const d = dObj(s); return `${DANI[d.getUTCDay()]}, ${d.getUTCDate()}. ${MJ[d.getUTCMonth()]}`; };
const mondayOf = (s) => addDays(s, -((dow(s) + 6) % 7));

const state = { tab: 'danas', today: null, status: null, services: [], settings: null, weekStart: null, calMode: 'tjedan', month: null };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Prijavite se ponovno.'); }
  if (!res.ok) throw new Error(data.error || 'Greška.');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}

const modal = {
  open(html, onMount) {
    $('#modal-body').innerHTML = html;
    const d = $('#modal');
    if (!d.open) d.showModal();
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => modal.close()));
    onMount?.($('#modal-body'));
  },
  close() { $('#modal').close(); },
};
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') modal.close(); });

// ---------- prijava ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#pw').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').hidden = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    start();
  } catch (err) {
    $('#login-err').textContent = err.message;
    $('#login-err').hidden = false;
  }
});

$('[data-action="logout"]').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});
$('[data-action="new-booking"]').addEventListener('click', () => newBookingModal());

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

function go(tab) {
  state.tab = tab;
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  history.replaceState(null, '', `#${tab}`);
  render();
}

async function render() {
  const v = $('#view');
  try {
    if (state.tab === 'danas') await viewToday(v);
    else if (state.tab === 'kalendar') await viewCalendar(v);
    else if (state.tab === 'zahtjevi') await viewPending(v);
    else if (state.tab === 'klijentice') await viewClients(v);
    else if (state.tab === 'postavke') await viewSettings(v);
  } catch (err) {
    v.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  refreshBadge();
}

async function refreshBadge() {
  try {
    const p = await api('/api/admin/pending');
    const b = $('#pending-badge');
    b.textContent = p.length;
    b.hidden = !p.length;
  } catch { /* ignore */ }
}

// ---------- zajednički prikaz rezervacije ----------
// 063 …, +387 63 …, 00387 63 … → 38763… (isto kao server/phone.js)
function phoneDigits(phone) {
  const raw = String(phone || '').trim();
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return '387' + d.slice(1);
  if (d.length <= 9) return '387' + d;
  return d;
}

function bookingRow(b, { showDate = false, quick = false } = {}) {
  const dim = ['odbijeno', 'otkazano', 'nije_dosla'].includes(b.status) ? 'dim' : '';
  return `<div class="row ${dim}" data-booking="${b.id}">
    <div class="time">${hhmm(b.start_min)}<small>${b.duration} min</small></div>
    <div>
      <div class="who">${esc(b.name)}</div>
      <div class="what">${esc(b.services.map((s) => s.name).join(' + '))} · ${km(b.total_price)}${showDate ? ' · ' + fmtDay(b.date) : ''}</div>
      ${b.note ? `<div class="what">„${esc(b.note)}”</div>` : ''}
    </div>
    <div class="actions">
      ${quick && b.status === 'na_cekanju' && b.started ? '<span class="status-pill st-nije_dosla">Prošlo</span>'
        : quick && b.status === 'na_cekanju' ? `<button class="btn btn-small" data-quick="potvrdeno">Potvrdi</button><button class="btn btn-small btn-outline" data-quick="odbijeno">Odbij</button>` : `<span class="status-pill st-${b.status}">${STATUS[b.status]}</span>`}
    </div>
  </div>`;
}

function blockRow(bl) {
  return `<div class="row block">
    <div class="time">${bl.start_min == null ? 'cijeli' : hhmm(bl.start_min)}<small>${bl.start_min == null ? 'dan' : '– ' + hhmm(bl.end_min)}</small></div>
    <div><div class="who">Blokirano</div><div class="what">${esc(bl.reason || 'Nedostupno')}</div></div>
    <div class="actions"><button class="btn btn-small btn-outline" data-unblock="${bl.id}">Ukloni</button></div>
  </div>`;
}

function wireRows(root, bookings) {
  $$('[data-booking]', root).forEach((row) => {
    row.addEventListener('click', (e) => {
      const b = bookings.find((x) => x.id === Number(row.dataset.booking));
      const quick = e.target.closest('[data-quick]');
      if (quick) {
        e.stopPropagation();
        if (quick.dataset.quick === 'odbijeno' && !confirm('Odbiti termin? Klijentica će odmah dobiti email.')) return;
        setStatus(b, quick.dataset.quick, true);
        return;
      }
      bookingModal(b);
    });
  });
  $$('[data-unblock]', root).forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Ukloniti blokadu?')) return;
    await api(`/api/admin/blocks/${btn.dataset.unblock}`, { method: 'DELETE' });
    toast('Blokada uklonjena.');
    render();
  }));
}

async function setStatus(b, status, notify) {
  try {
    await api(`/api/admin/bookings/${b.id}/status`, { method: 'POST', body: { status, notify } });
    const mailed = notify && b.email && status !== 'nije_dosla' && !(status === 'potvrdeno' && b.status === 'nije_dosla');
    toast(`${STATUS[status]}${mailed ? ' · klijentici je poslan email' : ''}`);
    modal.close();
    render();
  } catch (err) { toast(err.message); }
}

function bookingModal(b) {
  const wa = phoneDigits(b.phone);
  const tel = wa ? '+' + wa : '';
  const actions = {
    na_cekanju: [['potvrdeno', 'Potvrdi', ''], ['odbijeno', 'Odbij', 'btn-outline']],
    potvrdeno: [['otkazano', 'Otkaži', 'btn-outline'], ['nije_dosla', 'Nije došla', 'btn-outline']],
    odbijeno: [['potvrdeno', 'Ipak potvrdi', 'btn-outline']],
    otkazano: [['potvrdeno', 'Vrati termin', 'btn-outline']],
    nije_dosla: [['potvrdeno', 'Ipak je došla', 'btn-outline']],
  }[b.status] || [];
  modal.open(`
    <div class="modal-head"><h2>${esc(b.name)}</h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <span class="status-pill st-${b.status}">${STATUS[b.status]}</span>
    <dl class="kv">
      <dt>Usluga</dt><dd>${esc(b.services.map((s) => s.name).join(' + '))}</dd>
      <dt>Termin</dt><dd>${fmtDay(b.date)} · ${hhmm(b.start_min)}–${hhmm(b.start_min + b.duration)}</dd>
      <dt>Cijena</dt><dd>${km(b.total_price)}</dd>
      <dt>Mobitel</dt><dd>${b.phone ? `<a href="tel:${esc(tel)}">${esc(b.phone)}</a> · <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : '–'}</dd>
      <dt>Email</dt><dd>${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '–'}</dd>
      ${b.note ? `<dt>Napomena</dt><dd>${esc(b.note)}</dd>` : ''}
      <dt>Izvor</dt><dd>${b.source === 'admin' ? 'upisala Barbara' : 'online rezervacija'}</dd>
    </dl>
    ${actions.length ? `<label class="check small"><input type="checkbox" id="m-notify" ${b.email ? 'checked' : 'disabled'}> Pošalji email klijentici</label>
    <div class="btn-row">${actions.map(([s, l, c]) => `<button class="btn btn-small ${c}" data-set="${s}">${l}</button>`).join('')}</div>` : ''}
    <details>
      <summary class="label" style="cursor:pointer;padding:10px 0">Promijeni termin ili bilješku</summary>
      <form id="edit-form" class="form-grid" style="margin-top:12px">
        <div class="grid2">
          <div class="field compact"><label>Datum</label><input type="date" name="date" value="${b.date}" required></div>
          <div class="field compact"><label>Vrijeme</label><input type="time" name="time" step="900" value="${hhmm(b.start_min)}" required></div>
          <div class="field compact"><label>Trajanje (min)</label><input type="number" name="duration" min="15" step="15" value="${b.duration}"></div>
          <div class="field compact"><label>Cijena (KM)</label><input type="number" name="price" min="0" step="0.5" value="${b.total_price}"></div>
        </div>
        <div class="field compact"><label>Bilješka (vidi samo Barbara)</label><textarea name="admin_note">${esc(b.admin_note)}</textarea></div>
        <label class="check small"><input type="checkbox" name="notify" ${b.email && b.status === 'potvrdeno' ? 'checked' : ''}> Ako se termin pomakne, javi klijentici emailom</label>
        <button class="btn btn-small" type="submit">Spremi</button>
      </form>
    </details>
    ${b.client_id ? `<p class="small" style="margin-top:12px"><button class="btn-link" data-client="${b.client_id}">Karton klijentice</button></p>` : ''}
  `, (root) => {
    $$('[data-set]', root).forEach((btn) => btn.addEventListener('click', () => {
      const s = btn.dataset.set;
      if (['otkazano', 'odbijeno'].includes(s) && !confirm(`${s === 'otkazano' ? 'Otkazati' : 'Odbiti'} termin?`)) return;
      setStatus(b, s, $('#m-notify', root)?.checked);
    }));
    $('#edit-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { date: f.date.value, time: f.time.value, duration: Number(f.duration.value), price: f.price.value, admin_note: f.admin_note.value, notify: f.notify.checked } });
        toast('Spremljeno.');
        modal.close();
        render();
      } catch (err) {
        if (/već postoji/.test(err.message) && confirm(`${err.message} Spremiti svejedno?`)) {
          await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { date: f.date.value, time: f.time.value, duration: Number(f.duration.value), price: f.price.value, admin_note: f.admin_note.value, notify: f.notify.checked, force: true } });
          modal.close();
          render();
        } else toast(err.message);
      }
    });
    $('[data-client]', root)?.addEventListener('click', () => clientModal(b.client_id));
  });
}

// ---------- Danas ----------
async function viewToday(v) {
  const t = state.today;
  const [{ bookings, blocks }, pending] = await Promise.all([
    api(`/api/admin/bookings?from=${t}&to=${addDays(t, 1)}`),
    api('/api/admin/pending'),
  ]);
  const day = (date) => {
    const list = bookings.filter((b) => b.date === date && b.status !== 'odbijeno');
    const bls = blocks.filter((b) => b.date === date);
    const items = [...list.map((b) => ({ k: b.start_min, html: bookingRow(b, { quick: true }) })), ...bls.map((b) => ({ k: b.start_min ?? -1, html: blockRow(b) }))].sort((a, b) => a.k - b.k);
    const sum = list.filter((b) => b.status === 'potvrdeno').reduce((a, b) => a + b.total_price, 0);
    return `<div class="day-head"><h3>${date === t ? 'Danas' : 'Sutra'} · ${fmtDay(date)}</h3>${sum ? `<span class="label">${km(sum)}</span>` : ''}</div>
      <div class="panel">${items.length ? items.map((i) => i.html).join('') : '<div class="empty-row">Nema termina.</div>'}</div>`;
  };
  v.innerHTML = `
    ${pending.length ? `<div class="day-head"><h3>Čeka vašu potvrdu</h3><span class="label">${pending.length}</span></div>
      <div class="panel">${pending.slice(0, 5).map((b) => bookingRow(b, { showDate: true, quick: true })).join('')}</div>
      ${pending.length > 5 ? '<p><button class="btn-link" data-goto="zahtjevi">Svi zahtjevi</button></p>' : ''}` : ''}
    ${day(t)}
    ${day(addDays(t, 1))}`;
  wireRows(v, [...bookings, ...pending]);
  $('[data-goto]', v)?.addEventListener('click', () => go('zahtjevi'));
}

// ---------- Zahtjevi ----------
async function viewPending(v) {
  const pending = await api('/api/admin/pending');
  v.innerHTML = `<h2>Zahtjevi <em>na čekanju</em></h2>
    <div class="panel">${pending.length ? pending.map((b) => bookingRow(b, { showDate: true, quick: true })).join('') : '<div class="empty-row">Nema novih zahtjeva.</div>'}</div>`;
  wireRows(v, pending);
}

// ---------- Kalendar ----------
async function viewCalendar(v) {
  state.weekStart ||= mondayOf(state.today);
  state.month ||= state.today.slice(0, 7);
  const toolbar = (label, prev, next) => `
    <div class="toolbar">
      <div class="seg"><button data-mode="tjedan" class="${state.calMode === 'tjedan' ? 'active' : ''}">Tjedan</button><button data-mode="mjesec" class="${state.calMode === 'mjesec' ? 'active' : ''}">Mjesec</button></div>
      <span class="spacer"></span>
      <button class="round" data-nav="${prev}" aria-label="Natrag">‹</button>
      <button class="btn btn-small btn-outline" data-nav="danas">Danas</button>
      <button class="round" data-nav="${next}" aria-label="Naprijed">›</button>
    </div>
    <div class="toolbar"><h2 style="margin:0">${label}</h2><span class="spacer"></span><button class="btn btn-small btn-outline" data-action="block">Blokiraj vrijeme</button></div>`;

  if (state.calMode === 'tjedan') {
    const from = state.weekStart;
    const to = addDays(from, 6);
    const { bookings, blocks } = await api(`/api/admin/bookings?from=${from}&to=${to}`);
    const days = [...Array(7)].map((_, i) => addDays(from, i));
    const hours = state.settings.hours;
    v.innerHTML = toolbar(`${dObj(from).getUTCDate()}. – ${dObj(to).getUTCDate()}. ${MJ[dObj(to).getUTCMonth()]}`, -7, 7) + days.map((d) => {
      const list = bookings.filter((b) => b.date === d && b.status !== 'odbijeno');
      const bls = blocks.filter((b) => b.date === d);
      const items = [...list.map((b) => ({ k: b.start_min, html: bookingRow(b) })), ...bls.map((b) => ({ k: b.start_min ?? -1, html: blockRow(b) }))].sort((a, b) => a.k - b.k);
      const h = hours[dow(d)];
      return `<div class="day-head"><h3>${fmtDay(d)}${d === state.today ? ' · danas' : ''}</h3><span class="label">${h ? `${h.open}–${h.close}` : 'zatvoreno'}</span></div>
        <div class="panel">${items.length ? items.map((i) => i.html).join('') : '<div class="empty-row">Slobodno.</div>'}</div>`;
    }).join('');
    wireRows(v, bookings);
  } else {
    const [y, m] = state.month.split('-').map(Number);
    const from = `${state.month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${state.month}-${String(last).padStart(2, '0')}`;
    const { bookings, blocks } = await api(`/api/admin/bookings?from=${from}&to=${to}&status=potvrdeno,na_cekanju`);
    const offset = (dow(from) + 6) % 7;
    let cells = DANI_KR.map((d) => `<div class="dow">${d}</div>`).join('') + '<div></div>'.repeat(offset);
    for (let i = 1; i <= last; i++) {
      const d = `${state.month}-${String(i).padStart(2, '0')}`;
      const list = bookings.filter((b) => b.date === d);
      const pend = list.filter((b) => b.status === 'na_cekanju').length;
      const blocked = blocks.some((b) => b.date === d && b.start_min == null);
      const closed = !state.settings.hours[dow(d)] || blocked;
      cells += `<button class="cell ${d === state.today ? 'today' : ''} ${closed ? 'closed' : ''}" data-day="${d}"><span class="n">${i}</span>
        ${list.length ? `<span class="c">${list.length} ${list.length === 1 ? 'termin' : 'termina'}</span>` : ''}${pend ? `<span class="p">${pend} na čekanju</span>` : ''}${blocked ? '<span class="p">blokirano</span>' : ''}</button>`;
    }
    v.innerHTML = toolbar(`${MJ_NOM[m - 1]} ${y}.`, -1, 1) + `<div class="month">${cells}</div>`;
    $$('[data-day]', v).forEach((c) => c.addEventListener('click', () => {
      state.weekStart = mondayOf(c.dataset.day);
      state.calMode = 'tjedan';
      render();
    }));
  }
  $$('[data-mode]', v).forEach((b) => b.addEventListener('click', () => { state.calMode = b.dataset.mode; render(); }));
  $$('[data-nav]', v).forEach((b) => b.addEventListener('click', () => {
    const n = b.dataset.nav;
    if (n === 'danas') { state.weekStart = mondayOf(state.today); state.month = state.today.slice(0, 7); }
    else if (state.calMode === 'tjedan') state.weekStart = addDays(state.weekStart, Number(n));
    else { const [y, m] = state.month.split('-').map(Number); state.month = ymd(new Date(Date.UTC(y, m - 1 + Number(n), 1))).slice(0, 7); }
    render();
  }));
  $('[data-action="block"]', v).addEventListener('click', blockModal);
}

function blockModal() {
  modal.open(`
    <div class="modal-head"><h2>Blokiraj <em>vrijeme</em></h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <p class="small muted">Npr. godišnji odmor, privatne obaveze. U to vrijeme klijentice ne mogu rezervirati.</p>
    <form id="block-form" class="form-grid">
      <div class="grid2">
        <div class="field compact"><label>Od datuma</label><input type="date" name="date" value="${state.today}" required></div>
        <div class="field compact"><label>Do datuma</label><input type="date" name="dateTo" value="${state.today}"></div>
      </div>
      <label class="check small"><input type="checkbox" name="whole" checked> Cijeli dan</label>
      <div class="grid2" id="block-times" hidden>
        <div class="field compact"><label>Od</label><input type="time" name="from" value="12:00" step="900"></div>
        <div class="field compact"><label>Do</label><input type="time" name="to" value="14:00" step="900"></div>
      </div>
      <div class="field compact"><label>Razlog (nije obavezno)</label><input name="reason" placeholder="npr. godišnji odmor"></div>
      <button class="btn" type="submit">Blokiraj</button>
    </form>`, (root) => {
    const f = $('#block-form', root);
    f.whole.addEventListener('change', () => { $('#block-times', root).hidden = f.whole.checked; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { date: f.date.value, dateTo: f.dateTo.value || f.date.value, reason: f.reason.value };
        if (!f.whole.checked) { body.from = f.from.value; body.to = f.to.value; }
        const r = await api('/api/admin/blocks', { method: 'POST', body });
        toast(`Blokirano (${r.length} ${r.length === 1 ? 'dan' : 'dana'}).`);
        modal.close();
        render();
      } catch (err) { toast(err.message); }
    });
  });
}

function newBookingModal() {
  const svc = state.services.filter((s) => s.active);
  modal.open(`
    <div class="modal-head"><h2>Novi <em>termin</em></h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <p class="small muted">Za termine dogovorene telefonom ili porukom. Termin se odmah sprema kao potvrđen.</p>
    <form id="nb-form" class="form-grid">
      <div>${svc.map((s) => `<label class="check small" style="margin:6px 0"><input type="checkbox" name="svc" value="${esc(s.id)}"> ${esc(s.name)} · ${km(s.price)} · ${s.duration} min</label>`).join('')}</div>
      <div class="grid2">
        <div class="field compact"><label>Datum</label><input type="date" name="date" value="${state.today}" required></div>
        <div class="field compact"><label>Vrijeme</label><input type="time" name="time" step="900" value="10:00" required></div>
      </div>
      <div class="field compact"><label>Ime i prezime</label><input name="name" required autocomplete="off"></div>
      <div class="grid2">
        <div class="field compact"><label>Mobitel</label><input name="phone" type="tel"></div>
        <div class="field compact"><label>Email (nije obavezno)</label><input name="email" type="email"></div>
      </div>
      <div class="field compact"><label>Napomena</label><input name="note"></div>
      <label class="check small"><input type="checkbox" name="notify" checked> Pošalji potvrdu na email (ako je upisan)</label>
      <button class="btn" type="submit">Spremi termin</button>
    </form>`, (root) => {
    const f = $('#nb-form', root);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        services: $$('input[name=svc]:checked', f).map((i) => i.value),
        date: f.date.value, time: f.time.value, name: f.elements['name'].value, phone: f.phone.value, email: f.email.value, note: f.note.value, notify: f.notify.checked,
      };
      try {
        await api('/api/admin/bookings', { method: 'POST', body });
      } catch (err) {
        if (!/već postoji/.test(err.message) || !confirm(`${err.message} Spremiti svejedno?`)) { toast(err.message); return; }
        await api('/api/admin/bookings', { method: 'POST', body: { ...body, force: true } });
      }
      toast('Termin je spremljen.');
      modal.close();
      render();
    });
  });
}

// ---------- Klijentice ----------
async function viewClients(v, query = '') {
  const list = await api(`/api/admin/clients?q=${encodeURIComponent(query)}`);
  v.innerHTML = `<h2>Klijen<em>tice</em></h2>
    <div class="field compact" style="margin-bottom:12px"><input id="c-search" type="search" placeholder="Traži po imenu, mobitelu ili emailu" value="${esc(query)}"></div>
    <div class="panel">${list.length ? list.map((c) => `
      <div class="row" data-cid="${c.id}" style="grid-template-columns:1fr auto">
        <div><div class="who">${esc(c.name)}</div><div class="what">${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''}</div>${c.notes ? `<div class="what">${esc(c.notes)}</div>` : ''}</div>
        <div class="what" style="text-align:right">${c.visits} ${c.visits === 1 ? 'termin' : 'termina'}${c.no_shows ? `<br>${c.no_shows}× nije došla` : ''}${c.last_date ? `<br>zadnji ${fmtDay(c.last_date).split(', ')[1]}` : ''}</div>
      </div>`).join('') : '<div class="empty-row">Još nema klijentica.</div>'}</div>`;
  const s = $('#c-search', v);
  s.addEventListener('input', () => { clearTimeout(s.t); s.t = setTimeout(() => viewClients(v, s.value).then(() => { const n = $('#c-search'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 300); });
  $$('[data-cid]', v).forEach((r) => r.addEventListener('click', () => clientModal(Number(r.dataset.cid))));
}

async function clientModal(id) {
  const c = await api(`/api/admin/clients/${id}`);
  const tel = phoneDigits(c.phone) ? '+' + phoneDigits(c.phone) : '';
  modal.open(`
    <div class="modal-head"><h2>${esc(c.name)}</h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <dl class="kv">
      <dt>Mobitel</dt><dd>${c.phone ? `<a href="tel:${esc(tel)}">${esc(c.phone)}</a>` : '–'}</dd>
      <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '–'}</dd>
    </dl>
    <div class="field compact"><label>Bilješke (npr. alergije, omiljeni look, nijansa henne)</label><textarea id="c-notes">${esc(c.notes)}</textarea></div>
    <div class="btn-row"><button class="btn btn-small" id="c-save">Spremi bilješke</button></div>
    <h3>Povijest</h3>
    <div>${c.bookings.length ? c.bookings.map((b) => `<div class="row ${['odbijeno', 'otkazano', 'nije_dosla'].includes(b.status) ? 'dim' : ''}" style="cursor:default;grid-template-columns:1fr auto"><div><div class="who">${fmtDay(b.date)} · ${hhmm(b.start_min)}</div><div class="what">${esc(b.services.map((s) => s.name).join(' + '))} · ${km(b.total_price)}</div></div><span class="status-pill st-${b.status}">${STATUS[b.status]}</span></div>`).join('') : '<div class="empty-row">Nema termina.</div>'}</div>
    <p class="small" style="margin-top:20px"><button class="btn-link" id="c-del">Obriši podatke klijentice (na njezin zahtjev)</button></p>`, (root) => {
    $('#c-save', root).addEventListener('click', async () => {
      await api(`/api/admin/clients/${id}`, { method: 'PATCH', body: { notes: $('#c-notes', root).value } });
      toast('Bilješke spremljene.');
    });
    $('#c-del', root).addEventListener('click', async () => {
      if (!confirm('Trajno obrisati ime, kontakt i bilješke ove klijentice? Termini ostaju u kalendaru bez osobnih podataka.')) return;
      await api(`/api/admin/clients/${id}`, { method: 'DELETE' });
      toast('Podaci su obrisani.');
      modal.close();
      render();
    });
  });
}

// ---------- Postavke ----------
async function viewSettings(v) {
  const [services, settings, status, emails, cfg] = await Promise.all([
    api('/api/admin/services'), api('/api/admin/settings'), api('/api/admin/status'), api('/api/admin/emails'), api('/api/config'),
  ]);
  state.services = services;
  state.settings = settings;
  const { business: biz, hours, rules, notify } = settings;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const bookUrl = `${status.baseUrl}/rezerviraj`;

  v.innerHTML = `
    <h2>Postav<em>ke</em></h2>

    <h3>Link za Instagram</h3>
    <div class="panel" style="padding:16px 20px">
      <p class="small">Stavite ovaj link u Instagram bio i highlight „Info”. Otvara izravno rezervaciju.</p>
      <div class="toolbar"><code style="word-break:break-all">${esc(bookUrl)}</code><button class="btn btn-small btn-outline" id="copy-link">Kopiraj</button></div>
      <p class="small muted">Link za određenu uslugu: ${esc(bookUrl)}?usluga=sminkanje</p>
    </div>

    <h3>Usluge i cjenik</h3>
    <div class="panel" id="svc-editor"></div>
    <div class="btn-row"><button class="btn btn-small btn-outline" id="svc-add">+ Dodaj uslugu</button><button class="btn btn-small" id="svc-save">Spremi usluge</button></div>

    <h3>Radno vrijeme</h3>
    <div class="panel" style="padding:8px 20px">${order.map((d) => `
      <div class="hours-edit" data-day="${d}">
        <span style="text-transform:capitalize">${DANI[d]}</span>
        <label class="check small"><input type="checkbox" class="h-open" ${hours[d] ? 'checked' : ''}> radi</label>
        <input type="time" class="h-from" value="${hours[d]?.open || '09:00'}" step="1800">
        <input type="time" class="h-to" value="${hours[d]?.close || '19:00'}" step="1800">
      </div>`).join('')}
    </div>

    <h3>Pravila rezervacije</h3>
    <div class="panel" style="padding:16px 20px">
      <div class="grid2">
        <div class="field compact"><label>Najranije (sati unaprijed)</label><input type="number" id="r-notice" min="0" value="${rules.minNoticeHours}"></div>
        <div class="field compact"><label>Najkasnije (dana unaprijed)</label><input type="number" id="r-ahead" min="1" value="${rules.maxDaysAhead}"></div>
        <div class="field compact"><label>Otkazivanje do (sati prije)</label><input type="number" id="r-cancel" min="0" value="${rules.cancelHours}"></div>
        <div class="field compact"><label>Pauza između termina (min)</label><input type="number" id="r-buffer" min="0" step="5" value="${rules.bufferMin}"></div>
      </div>
      <label class="check small" style="margin-top:12px"><input type="checkbox" id="r-multi" ${rules.allowMultiple ? 'checked' : ''}> Klijentica može odabrati više usluga u jednom terminu</label>
      <label class="check small" style="margin-top:8px"><input type="checkbox" id="r-auto" ${rules.autoConfirm ? 'checked' : ''}> Automatski potvrdi svaku rezervaciju (bez ručne potvrde)</label>
    </div>

    <h3>Podaci o salonu</h3>
    <div class="panel" style="padding:16px 20px">
      <div class="grid2">
        <div class="field compact"><label>Adresa salona</label><input id="b-address" value="${esc(biz.address)}" placeholder="Ulica i broj"></div>
        <div class="field compact"><label>Grad</label><input id="b-city" value="${esc(biz.city)}"></div>
        <div class="field compact"><label>Telefon</label><input id="b-phone" value="${esc(biz.phone)}"></div>
        <div class="field compact"><label>Email</label><input id="b-email" value="${esc(biz.email)}"></div>
        <div class="field compact"><label>WhatsApp link</label><input id="b-wa" value="${esc(biz.whatsapp)}"></div>
        <div class="field compact"><label>Instagram</label><input id="b-ig" value="${esc(biz.instagram)}"></div>
      </div>
      <div class="field compact" style="margin-top:12px"><label>Lokacija na karti (naziv mjesta ili koordinate iz Google karata)</label><input id="b-map" value="${esc(biz.mapQuery)}" placeholder="npr. 43.3826, 17.5946"></div>
      <div class="field compact" style="margin-top:12px"><label>Link za Google recenzije (nije obavezno)</label><input id="b-review" value="${esc(biz.reviewUrl)}" placeholder="https://g.page/r/..."></div>
    </div>

    <h3>Automatski emailovi</h3>
    <div class="panel" style="padding:16px 20px">
      <label class="check small"><input type="checkbox" id="n-rem" ${notify.reminders ? 'checked' : ''}> Podsjetnik klijentici 24 h prije termina</label>
      <label class="check small" style="margin-top:8px"><input type="checkbox" id="n-thx" ${notify.thanks ? 'checked' : ''}> Zahvala i molba za recenziju dan nakon termina</label>
      <label class="check small" style="margin-top:8px"><input type="checkbox" id="n-sum" ${notify.dailySummary ? 'checked' : ''}> Jutarnji pregled dana meni na email (u 7:00)</label>
    </div>
    <div class="btn-row"><button class="btn" id="settings-save">Spremi postavke</button></div>

    <h3>Fotografije</h3>
    <div class="panel" style="padding:16px 20px">
      <p class="small">Radovi se prikazuju u galeriji na stranici. Jednu fotografiju možete označiti za odjeljak „O meni”.</p>
      <div class="thumbs" id="thumbs">${cfg.gallery.map((g) => `<figure><img src="/api/gallery/${g.id}" alt="">${g.caption === '#o-meni' ? '<figcaption>O meni</figcaption>' : ''}<button data-del-img="${g.id}" aria-label="Obriši">×</button></figure>`).join('')}</div>
      <div class="toolbar" style="margin-top:12px">
        <label class="btn btn-small btn-outline">Dodaj fotografije<input type="file" id="img-input" accept="image/*" multiple hidden></label>
        <label class="check small"><input type="checkbox" id="img-about"> za „O meni”</label>
      </div>
    </div>

    <h3>Email</h3>
    <div class="panel" style="padding:16px 20px">
      <p class="small">${status.emailConfigured ? `Slanje emailova je uključeno. Obavijesti stižu na <strong>${esc(status.adminEmail)}</strong>.` : '<strong>Slanje emailova još nije podešeno.</strong> Na Railwayu dodajte varijable MAIL_RELAY_URL i MAIL_RELAY_KEY (vidi README).'}</p>
      <div class="toolbar"><input id="test-to" type="email" value="${esc(status.adminEmail)}" style="min-height:40px;padding:6px 12px;border:1px solid var(--line);flex:1;min-width:200px"><button class="btn btn-small btn-outline" id="test-email">Pošalji probne emailove</button></div>
      <table class="log">${emails.slice(0, 15).map((e) => `<tr><td>${new Date(e.created_at).toLocaleString('hr-HR', { timeZone: 'Europe/Sarajevo', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(e.subject)}<br><span class="muted">${esc(e.to_addr)}</span></td><td>${e.status === 'poslano' ? 'poslano' : `<span class="error">${esc(e.status)}</span>`}</td></tr>`).join('') || '<tr><td class="muted">Još nema poslanih emailova.</td></tr>'}</table>
    </div>`;

  // Usluge
  const editor = $('#svc-editor', v);
  const svcHtml = (s, i) => `
    <div class="svc-edit" data-i="${i}">
      <div class="field compact"><label>Kategorija</label><input class="s-cat" value="${esc(s.category)}" list="cats"></div>
      <div class="field compact"><label>Naziv</label><input class="s-name" value="${esc(s.name)}"></div>
      <div class="field compact"><label>Cijena KM</label><input class="s-price" type="number" min="0" step="0.5" value="${s.price}"></div>
      <div class="field compact"><label>Trajanje</label><input class="s-dur" type="number" min="15" step="15" value="${s.duration}"></div>
      <div class="field compact"><label>Termini svakih</label><select class="s-step">${[15, 30, 60].map((n) => `<option value="${n}" ${n === s.slot_step ? 'selected' : ''}>${n} min</option>`).join('')}</select></div>
      <div class="btn-row" style="margin:0"><button class="round s-up" title="Gore">↑</button><button class="round s-del" title="Obriši">×</button></div>
      <div class="field compact desc"><label>Kratki opis</label><input class="s-desc" value="${esc(s.description)}"></div>
      <label class="check small"><input type="checkbox" class="s-active" ${s.active ? 'checked' : ''}> prikazano</label>
      <input type="hidden" class="s-id" value="${esc(s.id || '')}">
    </div>`;
  let svcList = services.map((s) => ({ ...s }));
  const readSvc = () => $$('.svc-edit', editor).map((row) => ({
    id: $('.s-id', row).value || $('.s-name', row).value,
    category: $('.s-cat', row).value, name: $('.s-name', row).value, price: Number($('.s-price', row).value),
    duration: Number($('.s-dur', row).value), slot_step: Number($('.s-step', row).value), description: $('.s-desc', row).value, active: $('.s-active', row).checked,
  }));
  const drawSvc = () => {
    editor.innerHTML = svcList.map(svcHtml).join('') + '<datalist id="cats"><option>MAKEUP</option><option>BROWS</option><option>FACE</option></datalist>';
    $$('.s-up', editor).forEach((b, i) => b.addEventListener('click', () => { svcList = readSvc(); if (i > 0) [svcList[i - 1], svcList[i]] = [svcList[i], svcList[i - 1]]; drawSvc(); }));
    $$('.s-del', editor).forEach((b, i) => b.addEventListener('click', () => { if (!confirm('Obrisati uslugu? (Postojeće rezervacije ostaju.)')) return; svcList = readSvc(); svcList.splice(i, 1); drawSvc(); }));
  };
  drawSvc();
  $('#svc-add', v).addEventListener('click', () => { svcList = readSvc(); svcList.push({ id: '', category: 'BROWS', name: '', price: 0, duration: 30, slot_step: 30, description: '', active: true }); drawSvc(); });
  $('#svc-save', v).addEventListener('click', async () => {
    try { state.services = await api('/api/admin/services', { method: 'PUT', body: readSvc() }); svcList = state.services.map((s) => ({ ...s })); drawSvc(); toast('Usluge spremljene.'); } catch (err) { toast(err.message); }
  });

  $('#copy-link', v).addEventListener('click', () => navigator.clipboard?.writeText(bookUrl).then(() => toast('Link kopiran.')));

  $('#settings-save', v).addEventListener('click', async () => {
    const hrs = {};
    $$('.hours-edit', v).forEach((row) => {
      hrs[row.dataset.day] = $('.h-open', row).checked ? { open: $('.h-from', row).value, close: $('.h-to', row).value } : null;
    });
    try {
      state.settings = await api('/api/admin/settings', {
        method: 'PUT',
        body: {
          hours: hrs,
          rules: { minNoticeHours: $('#r-notice').value, maxDaysAhead: $('#r-ahead').value, cancelHours: $('#r-cancel').value, bufferMin: $('#r-buffer').value, allowMultiple: $('#r-multi').checked, autoConfirm: $('#r-auto').checked },
          business: { address: $('#b-address').value, city: $('#b-city').value, phone: $('#b-phone').value, email: $('#b-email').value, whatsapp: $('#b-wa').value, instagram: $('#b-ig').value, reviewUrl: $('#b-review').value, mapQuery: $('#b-map').value },
          notify: { reminders: $('#n-rem').checked, thanks: $('#n-thx').checked, dailySummary: $('#n-sum').checked },
        },
      });
      toast('Postavke spremljene.');
    } catch (err) { toast(err.message); }
  });

  $('#img-input', v).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    for (const file of files) {
      try {
        const dataUrl = await shrinkImage(file);
        await api('/api/admin/gallery', { method: 'POST', body: { dataUrl, caption: $('#img-about').checked ? '#o-meni' : '' } });
      } catch (err) { toast(err.message); }
    }
    toast('Fotografije dodane.');
    render();
  });
  $$('[data-del-img]', v).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Obrisati fotografiju?')) return;
    await api(`/api/admin/gallery/${b.dataset.delImg}`, { method: 'DELETE' });
    render();
  }));

  $('#test-email', v).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/admin/test-email', { method: 'POST', body: { to: $('#test-to').value } });
      toast(`Poslano ${r.sent} od ${r.total} probnih emailova na ${r.to}.`);
      render();
    } catch (err) { toast(err.message); } finally { e.target.disabled = false; }
  });
}

// Smanji fotografiju u pregledniku (najviše 1600 px) prije slanja
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Fotografija se ne može učitati.'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- start ----------
async function start() {
  const me = await api('/api/admin/me');
  if (!me.admin) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  const [status, settings, services] = await Promise.all([api('/api/admin/status'), api('/api/admin/settings'), api('/api/admin/services')]);
  state.today = status.today;
  state.status = status;
  state.settings = settings;
  state.services = services;
  const warn = [];
  if (!status.emailConfigured) warn.push('Emailovi se još ne šalju – na Railwayu dodajte MAIL_RELAY_URL i MAIL_RELAY_KEY (vidi README).');
  if (!settings.business.address) warn.push('Upišite adresu salona u Postavkama – prikazuje se u emailovima i na karti.');
  $('#banner').innerHTML = warn.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  const tab = location.hash.slice(1);
  go(['danas', 'kalendar', 'zahtjevi', 'klijentice', 'postavke'].includes(tab) ? tab : 'danas');
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) render(); });
start();
