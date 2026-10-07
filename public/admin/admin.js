// Administracija za Barbaru – radi i na mobitelu.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const km = (n) => `${Number(n).toLocaleString('hr-HR')}\u00a0KM`;
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
    else if (state.tab === 'analitika') await viewStats(v);
    else if (state.tab === 'postavke') await viewSettings(v);
  } catch (err) {
    v.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
  refreshBadge();
}

async function refreshBadge() {
  try {
    const [p, inq] = await Promise.all([
      api('/api/admin/pending'),
      state.settings?.features?.events ? api('/api/admin/inquiries') : [],
    ]);
    const n = p.length + inq.filter((i) => i.status === 'novi').length;
    const b = $('#pending-badge');
    b.textContent = n;
    b.hidden = !n;
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
  const ym = t.slice(0, 7);
  const [{ bookings, blocks }, pending, month] = await Promise.all([
    api(`/api/admin/bookings?from=${t}&to=${addDays(t, 1)}`),
    api('/api/admin/pending'),
    api(`/api/admin/stats?from=${ym}-01&to=${monthEnd(ym)}`).catch(() => null),
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
    ${day(addDays(t, 1))}
    ${month ? `<button class="summary-link" data-goto="analitika">
      <span><span class="label">${esc(MJ_NOM[Number(ym.slice(5)) - 1])}</span><br><b>${km(month.totals.revenue)}</b>
      <small>${termina(month.totals.done)} odrađeno${month.totals.upcoming ? ` · još ${month.totals.upcoming} dogovoreno` : ''}</small></span>
      <span class="btn-link">Analitika</span></button>` : ''}`;
  wireRows(v, [...bookings, ...pending]);
  $$('[data-goto]', v).forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));
}

// ---------- Zahtjevi ----------
const PARTS = { bilo_kada: 'bilo kada', prijepodne: 'prijepodne', poslijepodne: 'poslijepodne' };

async function viewPending(v) {
  const f = state.settings?.features || {};
  const [pending, waitlist, inquiries] = await Promise.all([
    api('/api/admin/pending'),
    f.waitlist ? api('/api/admin/waitlist') : [],
    f.events ? api('/api/admin/inquiries') : [],
  ]);
  v.innerHTML = `<h2>Zahtjevi <em>na čekanju</em></h2>
    <div class="panel">${pending.length ? pending.map((b) => bookingRow(b, { showDate: true, quick: true })).join('') : '<div class="empty-row">Nema novih zahtjeva.</div>'}</div>
    ${f.waitlist ? `<div class="day-head"><h3>Lista čekanja</h3>${waitlist.length ? `<span class="label">${waitlist.length}</span>` : ''}</div>
      <p class="small muted" style="margin-top:-4px">Kad se termin tog dana oslobodi, klijentice s liste automatski dobiju email.</p>
      <div class="panel">${waitlist.length ? waitlist.map((w) => `<div class="row stack" style="cursor:default">
        <div><div class="who">${esc(w.name)}</div>
          <div class="what">${esc(fmtDay(w.date))} · ${esc(PARTS[w.part] || '')} · ${esc(w.services.map((s) => s.name).join(' + '))}</div>
          <div class="what">${esc(w.phone)}${w.email ? ' · ' + esc(w.email) : ''}${w.notified_at ? ` · obaviještena ${esc(fmtStamp(w.notified_at))}` : ''}</div>
          ${w.note ? `<div class="what">„${esc(w.note)}”</div>` : ''}</div>
        <div class="actions">${phoneDigits(w.phone) ? `<a class="btn btn-small" href="https://wa.me/${phoneDigits(w.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button class="btn btn-small btn-outline" data-wl-del="${w.id}">Ukloni</button></div>
      </div>`).join('') : '<div class="empty-row">Nitko nije na listi čekanja.</div>'}</div>` : ''}
    ${f.events ? `<div class="day-head"><h3>Vjenčanja i svečanosti</h3>${inquiries.length ? `<span class="label">${inquiries.length}</span>` : ''}</div>
      <div class="panel">${inquiries.length ? inquiries.map(inquiryRow).join('') : '<div class="empty-row">Nema otvorenih upita.</div>'}</div>` : ''}`;
  wireRows(v, pending);
  wireInquiries(v, inquiries);
  $$('[data-wl-del]', v).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ukloniti klijenticu s liste čekanja? Neće dobiti email kad se termin oslobodi.')) return;
    await api(`/api/admin/waitlist/${b.dataset.wlDel}`, { method: 'DELETE' });
    render();
  }));
}

const dayYear = (d) => `${fmtDay(d)}${d.slice(0, 4) !== state.today.slice(0, 4) ? ` ${d.slice(0, 4)}.` : ''}`;

function inquiryRow(i) {
  const wa = phoneDigits(i.phone);
  return `<div class="row stack" style="cursor:default">
    <div><div class="who">${esc(i.name)} <span class="status-pill inq-${i.status}">${esc(i.status_label)}</span></div>
      <div class="what">${esc(i.kind_label)} · ${esc(dayYear(i.event_date))}${i.ready_by ? ` · spremna do ${esc(i.ready_by)}` : ''} · ${i.people} ${i.people === 1 ? 'osoba' : i.people < 5 ? 'osobe' : 'osoba'}${i.location ? ` · ${esc(i.location)}` : ''}</div>
      <div class="what">${esc(i.phone)}${i.email ? ' · ' + esc(i.email) : ''}</div>
      ${i.note ? `<div class="what">„${esc(i.note)}”</div>` : ''}
      ${i.day_bookings ? `<div class="what">Taj dan već imate ${termina(i.day_bookings)}.</div>` : ''}
      ${i.deposit ? `<div class="what">Kapara ${km(i.deposit)}${i.deposit_paid_at ? ' · plaćena' : i.deposit_sent_at ? ` · upute poslane ${esc(fmtStamp(i.deposit_sent_at))}` : ''}</div>` : ''}
    </div>
    <div class="actions">
      ${wa ? `<a class="btn btn-small btn-outline" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      ${i.status !== 'potvrdeno' ? `<button class="btn btn-small btn-outline" data-inq-dep="${i.id}">${i.status === 'kapara_poslana' ? 'Ponovno pošalji upute' : 'Zatraži kaparu'}</button><button class="btn btn-small" data-inq-paid="${i.id}">Kapara plaćena</button>` : `<button class="btn btn-small btn-outline" data-inq-block="${i.id}">Blokiraj taj dan</button>`}
      <button class="btn-link" data-inq-close="${i.id}">Zatvori</button>
    </div>
  </div>`;
}

function wireInquiries(root, list) {
  const find = (id) => list.find((i) => i.id === Number(id));
  $$('[data-inq-dep]', root).forEach((b) => b.addEventListener('click', async () => {
    const i = find(b.dataset.inqDep);
    const amount = prompt(`Iznos kapare za ${i.name} (KM):`, i.deposit || 50);
    if (amount == null) return;
    try { await api(`/api/admin/inquiries/${i.id}/deposit`, { method: 'POST', body: { deposit: Number(String(amount).replace(',', '.')) } }); toast('Upute za kaparu su poslane emailom.'); render(); } catch (err) { alert(err.message); }
  }));
  $$('[data-inq-paid]', root).forEach((b) => b.addEventListener('click', async () => {
    const i = find(b.dataset.inqPaid);
    if (!confirm(`Kapara je plaćena? ${i.name} će dobiti email da je datum rezerviran.`)) return;
    try { await api(`/api/admin/inquiries/${i.id}/paid`, { method: 'POST', body: {} }); toast('Datum je potvrđen.'); render(); } catch (err) { toast(err.message); }
  }));
  $$('[data-inq-block]', root).forEach((b) => b.addEventListener('click', async () => {
    const i = find(b.dataset.inqBlock);
    if (!confirm(`Blokirati cijeli dan (${dayYear(i.event_date)}) za online rezervacije?`)) return;
    try { await api('/api/admin/blocks', { method: 'POST', body: { date: i.event_date, reason: `${i.kind_label}: ${i.name}` } }); toast('Dan je blokiran.'); } catch (err) { toast(err.message); }
  }));
  $$('[data-inq-close]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Zatvoriti upit? Nestaje s popisa (klijentica ne dobiva email).')) return;
    await api(`/api/admin/inquiries/${b.dataset.inqClose}`, { method: 'PATCH', body: { status: 'zatvoreno' } });
    render();
  }));
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
    const { bookings, blocks, holidays = {} } = await api(`/api/admin/bookings?from=${from}&to=${to}`);
    const days = [...Array(7)].map((_, i) => addDays(from, i));
    const hours = state.settings.hours;
    v.innerHTML = toolbar(`${dObj(from).getUTCDate()}. – ${dObj(to).getUTCDate()}. ${MJ[dObj(to).getUTCMonth()]}`, -7, 7) + days.map((d) => {
      const list = bookings.filter((b) => b.date === d && b.status !== 'odbijeno');
      const bls = blocks.filter((b) => b.date === d);
      const items = [...list.map((b) => ({ k: b.start_min, html: bookingRow(b) })), ...bls.map((b) => ({ k: b.start_min ?? -1, html: blockRow(b) }))].sort((a, b) => a.k - b.k);
      const h = hours[dow(d)];
      return `<div class="day-head"><h3>${fmtDay(d)}${d === state.today ? ' · danas' : ''}</h3><span class="label">${holidays[d] ? `praznik · ${esc(holidays[d])}` : h ? `${h.open}–${h.close}` : 'zatvoreno'}</span></div>
        <div class="panel">${items.length ? items.map((i) => i.html).join('') : '<div class="empty-row">Slobodno.</div>'}</div>`;
    }).join('');
    wireRows(v, bookings);
  } else {
    const [y, m] = state.month.split('-').map(Number);
    const from = `${state.month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${state.month}-${String(last).padStart(2, '0')}`;
    const { bookings, blocks, holidays = {} } = await api(`/api/admin/bookings?from=${from}&to=${to}&status=potvrdeno,na_cekanju`);
    const offset = (dow(from) + 6) % 7;
    let cells = DANI_KR.map((d) => `<div class="dow">${d}</div>`).join('') + '<div></div>'.repeat(offset);
    for (let i = 1; i <= last; i++) {
      const d = `${state.month}-${String(i).padStart(2, '0')}`;
      const list = bookings.filter((b) => b.date === d);
      const pend = list.filter((b) => b.status === 'na_cekanju').length;
      const blocked = blocks.some((b) => b.date === d && b.start_min == null);
      const closed = !state.settings.hours[dow(d)] || blocked || Boolean(holidays[d]);
      cells += `<button class="cell ${d === state.today ? 'today' : ''} ${closed ? 'closed' : ''}" data-day="${d}"><span class="n">${i}</span>
        ${list.length ? `<span class="c">${list.length} ${list.length === 1 ? 'termin' : 'termina'}</span>` : ''}${pend ? `<span class="p">${pend} na čekanju</span>` : ''}${blocked ? '<span class="p">blokirano</span>' : ''}${holidays[d] ? `<span class="p">${esc(holidays[d])}</span>` : ''}</button>`;
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
async function viewClients(v) {
  const f = state.settings?.features || {};
  v.innerHTML = `<h2>Klijen<em>tice</em></h2>
    <div id="c-extras"></div>
    ${f.vouchers || f.reviews ? '<h3>Sve klijentice</h3>' : ''}
    <div class="field compact" style="margin-bottom:12px"><input id="c-search" type="search" placeholder="Traži po imenu, mobitelu ili emailu"></div>
    <div class="panel" id="c-list"></div>`;
  const box = $('#c-list', v);
  const draw = async (query = '') => {
    const list = await api(`/api/admin/clients?q=${encodeURIComponent(query)}`);
    box.innerHTML = list.length ? list.map((c) => `
      <div class="row" data-cid="${c.id}" style="grid-template-columns:1fr auto">
        <div><div class="who">${esc(c.name)}</div><div class="what">${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''}</div>${c.notes ? `<div class="what">${esc(c.notes)}</div>` : ''}</div>
        <div class="what" style="text-align:right">${c.visits} ${c.visits === 1 ? 'termin' : 'termina'}${c.no_shows ? `<br>${c.no_shows}× nije došla` : ''}${c.last_date ? `<br>zadnji ${fmtDay(c.last_date).split(', ')[1]}` : ''}</div>
      </div>`).join('') : `<div class="empty-row">${query ? 'Nitko ne odgovara pretrazi.' : 'Još nema klijentica.'}</div>`;
    $$('[data-cid]', box).forEach((r) => r.addEventListener('click', () => clientModal(Number(r.dataset.cid))));
  };
  await Promise.all([draw(), renderClientExtras($('#c-extras', v), f)]);
  const s = $('#c-search', v);
  s.addEventListener('input', () => { clearTimeout(s.t); s.t = setTimeout(() => draw(s.value), 300); });
}

// Poklon bonovi i recenzije (kad su uključeni) iznad popisa klijentica
const VOUCHER_STATUS = { naruceno: 'Čeka plaćanje', aktivan: 'Aktivan', iskoristen: 'Iskorišten', otkazan: 'Otkazan' };
const stars = (n) => `<span class="stars-view" aria-label="${n} od 5">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`;

async function renderClientExtras(root, f) {
  const [vouchers, reviews] = await Promise.all([f.vouchers ? api('/api/admin/vouchers') : [], f.reviews ? api('/api/admin/reviews') : []]);
  const open = vouchers.filter((x) => ['naruceno', 'aktivan'].includes(x.status));
  const closed = vouchers.filter((x) => !['naruceno', 'aktivan'].includes(x.status));
  const voucherRow = (x) => `<div class="row stack" style="cursor:default">
    <div><div class="who">${km(x.status === 'aktivan' ? x.balance : x.amount)}${x.status === 'aktivan' && x.balance < x.amount ? ` <small class="muted">od ${km(x.amount)}</small>` : ''} <span class="status-pill v-${x.status}">${esc(x.expired && x.status === 'aktivan' ? 'Istekao' : VOUCHER_STATUS[x.status])}</span></div>
      <div class="what"><code>${esc(x.code)}</code>${x.recipient ? ` · za ${esc(x.recipient)}` : ''}${x.expires_on ? ` · vrijedi do ${esc(shortDate(x.expires_on))}` : ''}</div>
      <div class="what">${x.buyer_name ? `Kupio/la: ${esc(x.buyer_name)}` : 'Napravljen u salonu'}${x.buyer_phone ? ' · ' + esc(x.buyer_phone) : ''}${x.buyer_email ? ' · ' + esc(x.buyer_email) : ''}</div>
      ${x.redemptions?.length ? `<div class="what">Iskorišteno: ${x.redemptions.map((r) => `${esc(shortDate(r.date))} ${km(r.amount)}`).join(', ')}</div>` : ''}
    </div>
    <div class="actions">
      ${x.status === 'naruceno' ? `<button class="btn btn-small" data-v-paid="${x.id}">Plaćeno, pošalji bon</button>` : ''}
      ${x.status !== 'naruceno' ? `<a class="btn btn-small btn-outline" href="${esc(x.link)}" target="_blank" rel="noopener">Bon</a>` : ''}
      ${['naruceno', 'aktivan'].includes(x.status) ? `<button class="btn-link" data-v-cancel="${x.id}">Otkaži</button>` : ''}
    </div>
  </div>`;
  const fresh = reviews.filter((r) => r.status === 'nova');
  const done = reviews.filter((r) => r.status !== 'nova');
  const pub = done.filter((r) => r.status === 'objavljena');
  const reviewRow = (r) => `<div class="row stack" style="cursor:default">
    <div><div class="who">${stars(r.rating)} ${esc(r.name)}</div>
      <div class="what">${esc(r.services)}${r.date ? ` · ${esc(fmtDay(r.date))}` : ''}${r.status === 'skrivena' ? ' · skrivena' : ''}</div>
      ${r.text ? `<div class="what">„${esc(r.text)}”</div>` : ''}</div>
    <div class="actions">
      ${r.status !== 'objavljena' ? `<button class="btn btn-small" data-rv="${r.id}" data-st="objavljena">Objavi</button>` : ''}
      ${r.status !== 'skrivena' ? `<button class="btn btn-small btn-outline" data-rv="${r.id}" data-st="skrivena">${r.status === 'objavljena' ? 'Makni sa stranice' : 'Ne objavljuj'}</button>` : ''}
    </div>
  </div>`;

  root.innerHTML = `
    ${f.vouchers ? `<div class="day-head"><h3>Poklon bonovi</h3><span class="spacer"></span><button class="btn btn-small" data-v-redeem>Iskoristi bon</button><button class="btn btn-small btn-outline" data-v-new>+ Novi bon</button></div>
      <div class="panel">${open.length ? open.map(voucherRow).join('') : '<div class="empty-row">Nema aktivnih ni naručenih bonova.</div>'}
      ${closed.length ? `<details class="more"><summary>Iskorišteni i otkazani (${closed.length})</summary>${closed.map(voucherRow).join('')}</details>` : ''}</div>` : ''}
    ${f.reviews ? `<div class="day-head"><h3>Recenzije</h3>${pub.length ? `<span class="label">${pub.length} na stranici · prosjek ${(pub.reduce((a, r) => a + r.rating, 0) / pub.length).toLocaleString('hr-HR', { maximumFractionDigits: 1 })}</span>` : ''}</div>
      <div class="panel">${fresh.length ? fresh.map(reviewRow).join('') : '<div class="empty-row">Nema novih recenzija za pregled.</div>'}
      ${done.length ? `<details class="more"><summary>Pregledane (${done.length})</summary>${done.map(reviewRow).join('')}</details>` : ''}</div>` : ''}`;

  const again = () => renderClientExtras(root, f);
  $$('[data-v-paid]', root).forEach((b) => b.addEventListener('click', async () => {
    const x = vouchers.find((y) => y.id === Number(b.dataset.vPaid));
    if (!confirm(`Bon od ${km(x.amount)} je plaćen? ${x.buyer_email ? `Kupac će ga dobiti emailom (${x.buyer_email}).` : ''}`)) return;
    try { const r = await api(`/api/admin/vouchers/${x.id}/paid`, { method: 'POST', body: {} }); toast(r.sent ? 'Bon je poslan kupcu.' : 'Bon je aktivan.'); again(); } catch (err) { toast(err.message); }
  }));
  $$('[data-v-cancel]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Otkazati bon? Kod više neće vrijediti.')) return;
    try { await api(`/api/admin/vouchers/${b.dataset.vCancel}`, { method: 'DELETE' }); again(); } catch (err) { toast(err.message); }
  }));
  $('[data-v-redeem]', root)?.addEventListener('click', () => redeemModal(again));
  $('[data-v-new]', root)?.addEventListener('click', () => newVoucherModal(again));
  $$('[data-rv]', root).forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/reviews/${b.dataset.rv}/status`, { method: 'POST', body: { status: b.dataset.st } });
    toast(b.dataset.st === 'objavljena' ? 'Recenzija je na stranici.' : 'Recenzija se ne prikazuje.');
    again();
  }));
}

function redeemModal(done) {
  modal.open(`
    <div class="modal-head"><h2>Iskoristi <em>bon</em></h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <div class="field compact"><label>Kod s bona</label><input id="vr-code" placeholder="BSB-XXXX-XXXX" autocapitalize="characters" autocomplete="off"></div>
    <div class="btn-row"><button class="btn btn-small btn-outline" id="vr-find">Provjeri</button></div>
    <div id="vr-info"></div>`, (root) => {
    let found = null;
    const info = $('#vr-info', root);
    const find = async () => {
      try {
        found = await api(`/api/admin/vouchers/find?code=${encodeURIComponent($('#vr-code', root).value)}`);
      } catch (err) { info.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
      const usable = found.status === 'aktivan' && !found.expired;
      info.innerHTML = `<dl class="kv">
          <dt>Na bonu</dt><dd><strong>${km(found.balance)}</strong>${found.balance < found.amount ? ` od ${km(found.amount)}` : ''}</dd>
          <dt>Status</dt><dd>${esc(found.expired && found.status === 'aktivan' ? `Istekao ${shortDate(found.expires_on)}` : VOUCHER_STATUS[found.status])}</dd>
          ${found.recipient ? `<dt>Za</dt><dd>${esc(found.recipient)}</dd>` : ''}
          ${found.expires_on ? `<dt>Vrijedi do</dt><dd>${esc(shortDate(found.expires_on))}</dd>` : ''}
        </dl>
        ${usable ? `<div class="field compact"><label>Iznos koji se plaća bonom (KM)</label><input id="vr-amount" type="number" min="0" step="0.5" value="${found.balance}"></div>
        <div class="btn-row"><button class="btn btn-small" id="vr-go">Iskoristi</button></div>` : ''}`;
      $('#vr-go', root)?.addEventListener('click', async () => {
        try {
          const r = await api('/api/admin/vouchers/redeem', { method: 'POST', body: { code: found.code, amount: Number($('#vr-amount', root).value) } });
          toast(r.balance > 0 ? `Iskorišteno. Na bonu je ostalo ${km(r.balance)}.` : 'Bon je iskorišten do kraja.');
          modal.close();
          done();
        } catch (err) { toast(err.message); }
      });
    };
    $('#vr-find', root).addEventListener('click', find);
    $('#vr-code', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
    $('#vr-code', root).focus();
  });
}

function newVoucherModal(done) {
  const amounts = state.settings.extras?.voucherAmounts || [];
  modal.open(`
    <div class="modal-head"><h2>Novi <em>bon</em></h2><button class="close-x" data-close aria-label="Zatvori">×</button></div>
    <p class="small">Za bon koji je kupljen i plaćen u salonu. Odmah je aktivan.</p>
    <div class="grid2">
      <div class="field compact"><label>Iznos (KM)</label><input id="nv-amount" type="number" min="5" step="5" value="${amounts[1] || amounts[0] || 50}"></div>
      <div class="field compact"><label>Za koga (nije obavezno)</label><input id="nv-rec"></div>
      <div class="field compact"><label>Kupac (nije obavezno)</label><input id="nv-name"></div>
      <div class="field compact"><label>Email kupca (nije obavezno)</label><input id="nv-email" type="email"></div>
    </div>
    <div class="field compact" style="margin-top:8px"><label>Poruka na bonu (nije obavezno)</label><input id="nv-msg" maxlength="300"></div>
    <label class="check small" style="margin-top:8px"><input type="checkbox" id="nv-notify" checked> Pošalji bon kupcu emailom</label>
    <div class="btn-row"><button class="btn" id="nv-save">Napravi bon</button></div>`, (root) => {
    $('#nv-save', root).addEventListener('click', async () => {
      try {
        const r = await api('/api/admin/vouchers', { method: 'POST', body: {
          amount: Number($('#nv-amount', root).value), recipient: $('#nv-rec', root).value, buyer_name: $('#nv-name', root).value,
          buyer_email: $('#nv-email', root).value, message: $('#nv-msg', root).value, notify: $('#nv-notify', root).checked,
        } });
        modal.close();
        toast(`Bon ${r.code} je napravljen${r.sent ? ' i poslan emailom' : ''}.`);
        window.open(r.link, '_blank');
        done();
      } catch (err) { toast(err.message); }
    });
  });
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

// ---------- Analitika ----------
const MJ_KR = ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'];
const pct = (x) => `${Math.round(x * 100)}\u00a0%`;
const num = (n) => Number(n).toLocaleString('hr-HR', { maximumFractionDigits: 1 });
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return ymd(new Date(Date.UTC(y, m, 0))); };
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return ymd(new Date(Date.UTC(y, m - 1 + n, 1))).slice(0, 7); };
const monthName = (ym) => `${MJ_NOM[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}.`;
const dayMonth = (s) => `${Number(s.slice(8, 10))}. ${MJ[Number(s.slice(5, 7)) - 1]}`;
const termina = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'termin' : 'termina'}`;

// Razdoblje i usporedba: tekući mjesec/godina uspoređuje se s istim brojem dana prije
function statsPeriod() {
  const s = state.stats;
  const t = state.today;
  if (s.mode === 'mjesec') {
    const p = shiftMonth(s.month, -1);
    const current = s.month === t.slice(0, 7);
    const prevTo = current ? [monthEnd(p), `${p}-${t.slice(8, 10)}`].sort()[0] : monthEnd(p);
    return { from: `${s.month}-01`, to: monthEnd(s.month), prevFrom: `${p}-01`, prevTo, title: monthName(s.month),
      prevLabel: current ? `${MJ_NOM[Number(p.slice(5, 7)) - 1]} do ${Number(t.slice(8, 10))}.` : MJ_NOM[Number(p.slice(5, 7)) - 1] };
  }
  if (s.mode === 'godina') {
    const current = String(s.year) === t.slice(0, 4);
    return { from: `${s.year}-01-01`, to: `${s.year}-12-31`, prevFrom: `${s.year - 1}-01-01`, prevTo: current ? `${s.year - 1}${t.slice(4)}` : `${s.year - 1}-12-31`,
      title: `${s.year}.`, prevLabel: current ? `${s.year - 1}. do ${dayMonth(t)}` : `${s.year - 1}.` };
  }
  return { title: 'Od početka' };
}

function delta(cur, prev, label, fmt) {
  if (prev == null) return '';
  const change = prev ? Math.round(((cur - prev) / prev) * 100) : null;
  const arrow = change == null || change === 0 ? '' : change > 0 ? ` · ↑\u00a0${change}\u00a0%` : ` · ↓\u00a0${Math.abs(change)}\u00a0%`;
  return `<small>${esc(label)}: ${fmt(prev)}${arrow}</small>`;
}

function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= v);
}

function monthChart(months, from, to) {
  const max = niceMax(Math.max(...months.map((m) => m.revenue + m.expected)));
  const every = months.length > 18 ? 3 : 1;
  const inRange = (m) => from && to && m.month >= from.slice(0, 7) && m.month <= to.slice(0, 7);
  const cols = months.map((m, i) => {
    const r = (m.revenue / max) * 100;
    const e = (m.expected / max) * 100;
    return `<button class="mcol${inRange(m) ? ' on' : ''}" data-i="${i}" aria-label="${esc(monthName(m.month))}">
      ${e ? `<i class="exp end" style="height:${e}%"></i>` : ''}${r ? `<i class="rev${e ? '' : ' end'}" style="height:${r}%"></i>` : ''}</button>`;
  }).join('');
  const labels = months.map((m, i) => `<span class="${inRange(m) ? 'on' : ''}">${(months.length - 1 - i) % every === 0 ? MJ_KR[Number(m.month.slice(5)) - 1] : ''}</span>`).join('');
  const hasExp = months.some((m) => m.expected);
  return `<div class="mchart">
      <div class="mplot">
        ${[1, 0.5, 0].map((f) => `<div class="mgrid" style="bottom:${f * 100}%"><span>${num(max * f)}</span></div>`).join('')}
        <div class="mcols">${cols}</div>
      </div>
      <div class="mlabels">${labels}</div>
    </div>
    <p class="readout" id="m-readout"></p>
    <p class="legend"><span><i class="sw rev"></i>Odrađeno</span>${hasExp ? '<span><i class="sw exp"></i>Dogovoreno (još nije odrađeno)</span>' : ''}</p>
    <details class="small"><summary>Prikaži kao tablicu</summary>
      <table class="log"><tr><td>Mjesec</td><td>Odrađeno</td><td>Dogovoreno</td><td>Termina</td></tr>
      ${months.slice().reverse().map((m) => `<tr><td>${esc(monthName(m.month))}</td><td>${km(m.revenue)}</td><td>${m.expected ? km(m.expected) : '–'}</td><td>${m.done}</td></tr>`).join('')}</table>
    </details>`;
}

function hbars(rows, value, text) {
  const max = Math.max(...rows.map(value), 1);
  return rows.map((r) => `<div class="hbar"><div class="hbar-top"><span>${esc(r.name)}</span><span>${text(r)}</span></div>
    <div class="hbar-track"><i style="width:${(value(r) / max) * 100}%"></i></div></div>`).join('');
}

function vbars(items) {
  const max = Math.max(...items.map((i) => i.n), 1);
  return `<div class="vbars">${items.map((i) => `<div class="vbar" title="${esc(i.title)}: ${termina(i.n)}">
    <div class="vt"><i style="height:${(i.n / max) * 100}%"></i>${i.n ? `<span class="v" style="bottom:${(i.n / max) * 100}%">${i.n}</span>` : ''}</div><span class="k">${esc(i.k)}</span></div>`).join('')}</div>`;
}

async function viewStats(v) {
  state.stats ||= { mode: 'mjesec', month: state.today.slice(0, 7), year: Number(state.today.slice(0, 4)) };
  const s = state.stats;
  const p = statsPeriod();
  const qs = p.from ? `from=${p.from}&to=${p.to}&prevFrom=${p.prevFrom}&prevTo=${p.prevTo}` : '';
  const d = await api(`/api/admin/stats?${qs}`);
  const t = d.totals;
  const prev = d.previous;
  const hours = state.settings?.hours || {};
  const openDays = [1, 2, 3, 4, 5, 6, 0];
  const weekdays = openDays.map((dw, i) => ({ k: DANI_KR[i], title: DANI[dw], n: d.weekdays[i] })).filter((x, i) => x.n || hours[openDays[i]]);
  const hs = Object.values(hours).filter(Boolean);
  const firstH = Math.min(...hs.map((h) => Math.floor(toMin(h.open) / 60)), ...Object.keys(d.hourly).map(Number));
  const lastH = Math.max(...hs.map((h) => Math.ceil(toMin(h.close) / 60) - 1), ...Object.keys(d.hourly).map(Number));
  const hourly = [];
  for (let h = firstH; h <= lastH; h++) hourly.push({ k: String(h), title: `${h}:00`, n: d.hourly[h] || 0 });
  const empty = !t.done && !t.upcoming && !t.cancelled && !t.noShow && !t.pending;

  v.innerHTML = `<h2>Anali<em>tika</em></h2>
    <div class="toolbar">
      <div class="seg">${[['mjesec', 'Mjesec'], ['godina', 'Godina'], ['sve', 'Sve']].map(([k, l]) => `<button data-mode="${k}" class="${s.mode === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="period-nav">
        ${s.mode !== 'sve' ? '<button class="round" data-step="-1" aria-label="Prethodno">‹</button>' : ''}
        <strong class="period">${esc(p.title)}</strong>
        ${s.mode !== 'sve' ? '<button class="round" data-step="1" aria-label="Sljedeće">›</button>' : ''}
      </div>
    </div>
    ${empty ? '<p class="small" style="color:var(--muted)">U ovom razdoblju još nema termina.</p>' : ''}
    <div class="kpis">
      <div class="kpi"><span class="label">Promet</span><b>${km(t.revenue)}</b>${delta(t.revenue, prev?.revenue, p.prevLabel, km)}<small>odrađeni termini${t.done ? ` · prosjek ${km(t.avg)}` : ''}</small></div>
      <div class="kpi"><span class="label">Odrađeno</span><b>${t.done}</b>${delta(t.done, prev?.done, p.prevLabel, String)}${t.upcoming ? `<small>još ${t.upcoming} dogovoreno · ${km(t.upcomingRevenue)}</small>` : ''}</div>
      <div class="kpi"><span class="label">Otkazano</span><b>${t.cancelled}</b><small>${pct(t.cancelRate)} rezervacija${t.cancelledLate ? ` · ${t.cancelledLate} kasno` : ''}</small></div>
      <div class="kpi"><span class="label">Nije došla</span><b>${t.noShow}</b><small>izgubljeno ${km(t.lostRevenue)} (s otkazanima)</small></div>
      <div class="kpi"><span class="label">Klijentice</span><b>${t.clients}</b><small>${s.mode === 'sve' ? `${t.repeatClients} dolazi više puta` : `${t.newClients} novih · ${t.returningClients} se vratilo`}</small></div>
      <div class="kpi"><span class="label">Popunjenost</span><b>${t.occupancy == null ? '–' : pct(t.occupancy)}</b><small>${num(t.bookedHours)} od ${num(t.openHours)} h radnog vremena</small></div>
      <div class="kpi"><span class="label">Online</span><b>${pct(t.onlineShare)}</b><small>rezervacija preko stranice${t.leadDays != null ? ` · u prosjeku ${num(t.leadDays)} dana unaprijed` : ''}</small></div>
      <div class="kpi"><span class="label">Na čekanju</span><b>${t.pending}</b><small>${t.rejected ? `${t.rejected} odbijeno` : 'čeka vašu potvrdu'}${t.expired ? ` · ${t.expired} prošlo nepotvrđeno` : ''}</small></div>
    </div>

    <h3>Promet po mjesecima</h3>
    <div class="panel chart-panel">${monthChart(d.months, p.from, p.to)}</div>

    <div class="grid2 stats-cols">
      <div><h3>Usluge</h3><div class="panel pad">${d.services.length ? hbars(d.services, (r) => r.revenue, (r) => `${r.count}× · ${km(r.revenue)}`) : '<div class="empty-row">Još nema odrađenih termina.</div>'}</div></div>
      <div><h3>Otkazivanja</h3><div class="panel pad"><dl class="kv tight">
        <dt>Otkazala klijentica</dt><dd>${t.cancelledByClient}</dd>
        <dt>Otkazao salon</dt><dd>${t.cancelledBySalon}</dd>
        ${t.cancelled - t.cancelledByClient - t.cancelledBySalon ? `<dt>Ranije (nije zapisano tko)</dt><dd>${t.cancelled - t.cancelledByClient - t.cancelledBySalon}</dd>` : ''}
        <dt>Kasno (manje od ${state.settings?.rules?.cancelHours ?? 24} h)</dt><dd>${t.cancelledLate}</dd>
        <dt>Nije došla</dt><dd>${t.noShow}${t.done + t.noShow ? ` (${pct(t.noShowRate)})` : ''}</dd>
        <dt>Izgubljeni promet</dt><dd>${km(t.lostRevenue)}</dd>
      </dl></div></div>
    </div>

    <div class="grid2 stats-cols">
      <div><h3>Dani u tjednu</h3><div class="panel pad">${vbars(weekdays)}</div></div>
      <div><h3>Sati</h3><div class="panel pad">${vbars(hourly)}</div></div>
    </div>

    <h3>Najvjernije klijentice</h3>
    <div class="panel">${d.topClients.length ? d.topClients.map((c) => `<div class="row" ${c.client_id ? `data-cid="${c.client_id}"` : ''} style="grid-template-columns:1fr auto">
      <div class="who">${esc(c.name)}</div><div class="what" style="text-align:right">${termina(c.visits)} · ${km(c.revenue)}</div></div>`).join('') : '<div class="empty-row">Još nema odrađenih termina u ovom razdoblju.</div>'}</div>

    <h3>Vrijeme je za poruku</h3>
    <p class="small" style="color:var(--muted);margin-top:-4px">Klijentice koje nisu bile više od 6 tjedana i nemaju novi termin.</p>
    <div class="panel">${d.comeback.length ? d.comeback.map((c) => `<div class="row stack" data-cid="${c.id}">
      <div><div class="who">${esc(c.name)}</div><div class="what">zadnji put ${esc(dayMonth(c.last_date))}${c.last_services ? ' · ' + esc(c.last_services) : ''} · ukupno ${termina(c.visits)}</div></div>
      <div class="actions">${c.whatsapp ? `<a class="btn btn-small" href="${esc(c.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${c.tel ? `<a class="btn btn-small btn-outline" href="${esc(c.tel)}">Nazovi</a>` : ''}</div></div>`).join('') : '<div class="empty-row">Nema nikoga za podsjetiti.</div>'}</div>
    <p style="margin-top:24px"><a class="btn btn-small btn-outline" href="/api/admin/stats.csv${p.from ? `?from=${p.from}&to=${p.to}` : ''}" download>Preuzmi termine za Excel</a></p>
    <p class="small" style="color:var(--muted)">Odrađeno = potvrđen termin koji je prošao. Ako klijentica nije došla, označite to u terminu pa se ne broji u promet.</p>`;

  $$('[data-mode]', v).forEach((b) => b.addEventListener('click', () => { s.mode = b.dataset.mode; render(); }));
  $$('[data-step]', v).forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.step);
    if (s.mode === 'mjesec') s.month = shiftMonth(s.month, n);
    else s.year += n;
    render();
  }));
  $$('[data-cid]', v).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a')) clientModal(Number(r.dataset.cid)); }));

  // Očitanje mjeseca na dodir / prelazak mišem
  const out = $('#m-readout', v);
  const show = (i) => {
    const m = d.months[i];
    $$('.mcol', v).forEach((c) => c.classList.toggle('hover', Number(c.dataset.i) === i));
    out.innerHTML = `<strong>${esc(monthName(m.month))}</strong> · ${km(m.revenue)} odrađeno${m.expected ? ` · ${km(m.expected)} dogovoreno` : ''} · ${termina(m.done)}${m.cancelled ? ` · ${m.cancelled} otkazano/nije došla` : ''}`;
  };
  const def = Math.max(0, d.months.findLastIndex((m) => p.to ? m.month <= p.to.slice(0, 7) : m.month <= state.today.slice(0, 7)));
  $$('.mcol', v).forEach((c) => {
    c.addEventListener('pointerenter', () => show(Number(c.dataset.i)));
    c.addEventListener('click', () => show(Number(c.dataset.i)));
  });
  $('.mcols', v).addEventListener('pointerleave', () => show(def));
  show(def);
}

// ---------- Dodatne mogućnosti ----------
// Svaka se uključuje prekidačem; opis i postavke vide se ispod naziva.
const FEATURES = [
  { k: 'push', t: 'Obavijesti na mobitel', d: 'Obavijest na mobitel čim stigne novi zahtjev za termin, otkazivanje ili upis na listu čekanja.' },
  { k: 'backup', t: 'Tjedna sigurnosna kopija', d: 'Svakog ponedjeljka ujutro kopija svih termina i klijentica stiže vam na email.' },
  { k: 'waitlist', t: 'Lista čekanja', d: 'Kad nema slobodnog termina, klijentica se upiše na listu i dobije email čim se termin oslobodi.' },
  { k: 'calendarFeed', t: 'Kalendar na mobitelu', d: 'Svi termini sami se pojavljuju u kalendaru na vašem iPhoneu ili u Google kalendaru.' },
  { k: 'holidays', t: 'Praznici', d: 'Na praznike se ne može rezervirati online, pa ih ne morate blokirati ručno.' },
  { k: 'rebook', t: 'Podsjetnik za novi termin', d: 'Nekoliko tjedana nakon obrva klijentica dobije email „Vrijeme je za nove obrve?” s linkom za rezervaciju.' },
  { k: 'reviews', t: 'Recenzije na stranici', d: 'Nakon termina klijentice ocijene uslugu, a ocjene koje odobrite prikazuju se na stranici.' },
  { k: 'vouchers', t: 'Poklon bonovi', d: 'Bon se naruči na stranici, kupac ga dobije emailom za ispis, a vi ga u salonu iskoristite po kodu.' },
  { k: 'priceList', t: 'Cjenik na stranici', d: 'Posebna sekcija s cjenikom ispod „O meni”. Cijene se vide i u koraku rezervacije, pa je sekcija zasad skrivena.' },
  { k: 'events', t: 'Vjenčanja i svečanosti', d: 'Obrazac za upit na stranici (vjenčanje, krizma, matura); kaparu tražite i potvrđujete jednim dodirom.' },
];
const CAT_LABEL = { BROWS: 'Obrve', FACE: 'Lice', MAKEUP: 'Šminka' };
const shortDate = (d) => `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}. ${d.slice(0, 4)}.`;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const deviceLabel = () => {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) || isIos() ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : 'Uređaj';
  const br = /edg\//i.test(ua) ? 'Edge' : /crios|chrome/i.test(ua) ? 'Chrome' : /fxios|firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ');
};
const b64ToBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(isIos() && !isStandalone()
      ? 'Na iPhoneu obavijesti rade kad administraciju dodate na početni zaslon: u Safariju dodirnite Dijeli → Dodaj na početni zaslon, otvorite je s početnog zaslona i ovdje ponovno uključite obavijesti.'
      : 'Ovaj preglednik ne podržava obavijesti. Pokušajte u Chromeu ili Safariju.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Obavijesti nisu dopuštene. Dopustite ih u postavkama preglednika za ovu stranicu.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = await api('/api/admin/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('/api/admin/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceLabel() } });
}

const fmtStamp = (t) => (t ? new Date(t).toLocaleString('hr-HR', { timeZone: 'Europe/Sarajevo', dateStyle: 'short', timeStyle: 'short' }) : '');

async function featurePanel(k, settings) {
  if (k === 'push') {
    const devices = await api('/api/admin/push/devices').catch(() => []);
    return `<p class="small">${devices.length ? 'Obavijesti stižu na:' : 'Još nijedan uređaj ne prima obavijesti. Uključite ih na mobitelu na kojem želite primati obavijesti.'}</p>
      ${devices.map((d) => `<div class="dev"><span>${esc(d.label || 'Uređaj')}<small>dodano ${esc(fmtStamp(d.created_at))}</small></span><button class="btn-link" data-dev-del="${d.id}">Ukloni</button></div>`).join('')}
      ${isIos() && !isStandalone() ? '<p class="small muted">Na iPhoneu: u Safariju dodirnite Dijeli → Dodaj na početni zaslon, pa administraciju otvarajte s početnog zaslona. Tek tada se obavijesti mogu uključiti.</p>' : ''}
      <div class="toolbar"><button class="btn btn-small" data-push-on>Uključi na ovom uređaju</button>${devices.length ? '<button class="btn btn-small btn-outline" data-push-test>Pošalji probnu obavijest</button>' : ''}</div>`;
  }
  if (k === 'backup') {
    const last = settings.meta?.lastBackup;
    return `<p class="small">${last ? `Zadnja kopija poslana: <strong>${esc(last.split('-').reverse().join('.'))}.</strong>` : 'Prva kopija stiže uskoro.'} Šalje se na ${esc(state.status?.adminEmail || settings.business.email)}.</p>
      <div class="toolbar"><button class="btn btn-small btn-outline" data-backup-send>Pošalji kopiju sada</button><a class="btn btn-small btn-outline" href="/api/admin/backup.json" download>Preuzmi kopiju</a></div>`;
  }
  if (k === 'waitlist') return '<p class="small">Upisi s liste čekanja vide se pod <button class="btn-link" data-goto="zahtjevi">Zahtjevi</button>.</p>';
  const x = settings.extras || {};
  if (k === 'calendarFeed') {
    const c = await api('/api/admin/calendar');
    return `<p class="small">Novi, promijenjeni i otkazani termini sami se osvježavaju u kalendaru na mobitelu.</p>
      <div class="toolbar"><a class="btn btn-small" href="${esc(c.webcal)}">Dodaj u kalendar na iPhoneu</a><button class="btn btn-small btn-outline" data-copy="${esc(c.url)}">Kopiraj link</button></div>
      <p class="small muted"><strong>iPhone:</strong> otvorite ovu stranicu na iPhoneu, dodirnite gumb iznad i zatim „Pretplati se”.<br><strong>Google kalendar:</strong> na računalu otvorite calendar.google.com → „Drugi kalendari” (+) → „Iz URL-a” i zalijepite link. Google osvježava rjeđe, pa promjene ondje mogu kasniti nekoliko sati.</p>
      <p class="small muted">Link je tajan, nemojte ga dijeliti. <button class="btn-link" data-cal-reset>Napravi novi link</button> (stari tada prestaje raditi).</p>`;
  }
  if (k === 'holidays') {
    const list = await api('/api/admin/holidays');
    const sel = x.holidays;
    return `<p class="small">Odabrani praznici zatvoreni su za online rezervacije. Vi i dalje možete ručno upisati termin.</p>
      <div class="hol-list">${list.map((h) => `<label class="check small"><input type="checkbox" data-hol="${h.k}" ${!sel || sel.includes(h.k) ? 'checked' : ''}><span>${esc(h.name)} <span class="muted">· ${h.dates.map(shortDate).join(' i ')}</span></span></label>`).join('')}</div>
      <div class="toolbar"><button class="btn btn-small" data-hol-save>Spremi praznike</button></div>`;
  }
  if (k === 'rebook') {
    const cats = [...new Set(state.services.map((sv) => sv.category))];
    const days = x.rebookDays || {};
    return `<p class="small">Email s linkom na istu uslugu stiže ujutro nakon zadanog broja dana, samo ako klijentica u međuvremenu nije sama rezervirala. Ista osoba ga dobiva najviše jednom u dva tjedna i može se odjaviti jednim klikom.</p>
      <div class="grid2">${cats.map((c) => `<div class="field compact"><label>${esc(CAT_LABEL[c] || c)}: nakon koliko dana</label><input type="number" min="0" max="365" data-rb="${esc(c)}" value="${Number(days[c]) || 0}"></div>`).join('')}</div>
      <p class="small muted">0 znači bez podsjetnika za tu vrstu usluge.</p>
      <div class="toolbar"><button class="btn btn-small" data-rb-save>Spremi</button></div>`;
  }
  if (k === 'reviews') {
    return `<p class="small">Dan nakon termina klijentica u emailu zahvale dobije gumb „Ocijenite termin”. Nove ocjene vidite pod <button class="btn-link" data-goto="klijentice">Klijentice</button>, a na stranici se prikazuju samo one koje objavite.</p>
      ${settings.notify?.thanks ? '' : '<p class="small error">Uključite i „Zahvala i molba za recenziju dan nakon termina” pod Automatski emailovi, inače link ne stiže klijenticama.</p>'}`;
  }
  if (k === 'vouchers') {
    return `<p class="small">Na stranici se pojavljuje sekcija „Poklon bon”. Narudžbe, plaćanje i iskorištavanje bonova su pod <button class="btn-link" data-goto="klijentice">Klijentice</button>.</p>
      <div class="grid2">
        <div class="field compact"><label>Iznosi (KM, odvojeni zarezom)</label><input id="x-amounts" value="${esc((x.voucherAmounts || []).join(', '))}"></div>
        <div class="field compact"><label>Bon vrijedi (mjeseci)</label><input id="x-months" type="number" min="1" max="36" value="${x.voucherMonths || 12}"></div>
      </div>
      <div class="field compact" style="margin-top:8px"><label>Kako se bon plaća (piše kupcu nakon narudžbe)</label><textarea id="x-payment" rows="3">${esc(x.voucherPayment || '')}</textarea></div>
      <div class="toolbar"><button class="btn btn-small" data-x-save="vouchers">Spremi</button></div>`;
  }
  if (k === 'events') {
    return `<p class="small">Na stranici se pojavljuje sekcija „Vjenčanja i svečanosti” s obrascem za upit. Upiti stižu pod <button class="btn-link" data-goto="zahtjevi">Zahtjevi</button>, na email i na mobitel.</p>
      <div class="field compact"><label>Upute za plaćanje kapare (šalju se klijentici jednim dodirom)</label><textarea id="x-deposit" rows="4" placeholder="npr. Uplata na račun: BA39 …&#10;Primatelj: Barbara Skoko&#10;Svrha: kapara, ime i datum">${esc(x.depositInfo || '')}</textarea></div>
      <div class="toolbar"><button class="btn btn-small" data-x-save="events">Spremi</button></div>`;
  }
  return '';
}

async function renderFeatures(root, settings) {
  const f = settings.features || {};
  const panels = await Promise.all(FEATURES.map((x) => (f[x.k] ? featurePanel(x.k, settings) : '')));
  root.innerHTML = FEATURES.map((x, i) => `
    <div class="feat${f[x.k] ? ' on' : ''}">
      <label class="feat-head">
        <span><strong>${esc(x.t)}</strong><small>${esc(x.d)}</small></span>
        <span class="switch"><input type="checkbox" data-feat="${x.k}" ${f[x.k] ? 'checked' : ''}><i></i></span>
      </label>
      ${f[x.k] ? `<div class="feat-body">${panels[i]}</div>` : ''}
    </div>`).join('');

  $$('[data-feat]', root).forEach((c) => c.addEventListener('change', async () => {
    try {
      state.settings = await api('/api/admin/settings', { method: 'PUT', body: { features: { [c.dataset.feat]: c.checked } } });
      toast(c.checked ? 'Uključeno.' : 'Isključeno.');
      renderFeatures(root, state.settings);
    } catch (err) { toast(err.message); c.checked = !c.checked; }
  }));
  $('[data-push-on]', root)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await enablePush(); toast('Obavijesti su uključene na ovom uređaju.'); renderFeatures(root, state.settings); } catch (err) { alert(err.message); } finally { e.target.disabled = false; }
  });
  $('[data-push-test]', root)?.addEventListener('click', async () => {
    try { const r = await api('/api/admin/push/test', { method: 'POST' }); toast(`Poslano na ${r.sent} ${r.sent === 1 ? 'uređaj' : 'uređaja'}.`); } catch (err) { toast(err.message); }
  });
  $$('[data-dev-del]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Ukloniti ovaj uređaj? Na njega više neće stizati obavijesti.')) return;
    await api(`/api/admin/push/devices/${b.dataset.devDel}`, { method: 'DELETE' });
    renderFeatures(root, state.settings);
  }));
  $('[data-backup-send]', root)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('/api/admin/backup/send', { method: 'POST' }); toast('Kopija je poslana na email.'); state.settings = await api('/api/admin/settings'); renderFeatures(root, state.settings); } catch (err) { toast(err.message); } finally { e.target.disabled = false; }
  });
  $$('[data-goto]', root).forEach((b) => b.addEventListener('click', () => go(b.dataset.goto)));

  const saveExtras = async (extras) => {
    try { state.settings = await api('/api/admin/settings', { method: 'PUT', body: { extras } }); toast('Spremljeno.'); renderFeatures(root, state.settings); } catch (err) { toast(err.message); }
  };
  $$('[data-copy]', root).forEach((b) => b.addEventListener('click', () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Link kopiran.'))));
  $('[data-cal-reset]', root)?.addEventListener('click', async () => {
    if (!confirm('Napraviti novi link? Kalendar koji koristi stari link prestat će se osvježavati, pa ćete ga trebati ponovno dodati.')) return;
    await api('/api/admin/calendar/reset', { method: 'POST' });
    toast('Napravljen je novi link.');
    renderFeatures(root, state.settings);
  });
  $('[data-hol-save]', root)?.addEventListener('click', () => {
    const boxes = $$('[data-hol]', root);
    const picked = boxes.filter((c) => c.checked).map((c) => c.dataset.hol);
    saveExtras({ holidays: picked.length === boxes.length ? null : picked });
  });
  $('[data-rb-save]', root)?.addEventListener('click', () => {
    const rebookDays = { ...(state.settings.extras?.rebookDays || {}) };
    $$('[data-rb]', root).forEach((i) => { rebookDays[i.dataset.rb] = Number(i.value) || 0; });
    saveExtras({ rebookDays });
  });
  $$('[data-x-save]', root).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.xSave === 'events') return saveExtras({ depositInfo: $('#x-deposit', root).value });
    return saveExtras({ voucherAmounts: $('#x-amounts', root).value, voucherMonths: $('#x-months', root).value, voucherPayment: $('#x-payment', root).value });
  }));
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
  const aboutPhotos = cfg.gallery.filter((g) => g.caption === '#o-meni');
  const about = aboutPhotos[0];
  const works = cfg.gallery.filter((g) => g.caption !== '#o-meni');

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

    <h3>Dodatne mogućnosti</h3>
    <div class="panel feats" id="features"></div>

    <h3>Fotografija za „O meni”</h3>
    <div class="panel about-edit">
      <div class="about-current"><img src="${about ? `/api/gallery/${about.id}` : ABOUT_DEFAULT}" alt="Fotografija u sekciji O meni"></div>
      <div>
        <p class="small">${about ? 'Prikazuje se fotografija koju ste dodali.' : 'Prikazuje se zadana fotografija.'} Najbolje izgleda uspravna fotografija omjera 4:5.</p>
        <div class="toolbar">
          <label class="btn btn-small btn-outline">Promijeni fotografiju<input type="file" id="about-input" accept="image/*" hidden></label>
          ${about ? '<button class="btn-link" id="about-reset">Vrati zadanu</button>' : ''}
        </div>
      </div>
    </div>

    <h3>Radovi</h3>
    <div class="panel" style="padding:16px 20px">
      <p class="small">Fotografije radova prikazuju se u sekciji „Radovi” na stranici. Dok ovdje nema nijedne, ta se sekcija ne prikazuje.</p>
      ${works.length ? `<div class="thumbs" id="thumbs">${works.map((g) => `<figure><img src="/api/gallery/${g.id}" alt=""><button data-del-img="${g.id}" aria-label="Obriši">×</button></figure>`).join('')}</div>` : ''}
      <div class="toolbar" style="margin-top:12px">
        <label class="btn btn-small btn-outline">Dodaj radove<input type="file" id="img-input" accept="image/*" multiple hidden></label>
      </div>
    </div>

    <h3>Email</h3>
    <div class="panel" style="padding:16px 20px">
      <p class="small">${status.emailConfigured ? `Slanje emailova je uključeno. Obavijesti stižu na <strong>${esc(status.adminEmail)}</strong>.` : '<strong>Slanje emailova još nije podešeno.</strong> Na Railwayu dodajte varijable MAIL_RELAY_URL i MAIL_RELAY_KEY (vidi README).'}</p>
      <div class="toolbar"><input id="test-to" type="email" value="${esc(status.adminEmail)}" style="min-height:40px;padding:6px 12px;border:1px solid var(--line);flex:1;min-width:200px"><button class="btn btn-small btn-outline" id="test-email">Pošalji probne emailove</button></div>
      <table class="log">${emails.slice(0, 15).map((e) => `<tr><td>${new Date(e.created_at).toLocaleString('hr-HR', { timeZone: 'Europe/Sarajevo', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(e.subject)}<br><span class="muted">${esc(e.to_addr)}</span></td><td>${e.status === 'poslano' ? 'poslano' : `<span class="error">${esc(e.status)}</span>`}</td></tr>`).join('') || '<tr><td class="muted">Još nema poslanih emailova.</td></tr>'}</table>
    </div>`;

  renderFeatures($('#features', v), settings);

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
    let ok = 0;
    for (const file of files) {
      try {
        const dataUrl = await shrinkImage(file);
        await api('/api/admin/gallery', { method: 'POST', body: { dataUrl, caption: '' } });
        ok++;
      } catch (err) { toast(err.message); }
    }
    if (ok) toast(ok === 1 ? 'Rad je dodan.' : `Dodano radova: ${ok}.`);
    render();
  });
  $('#about-input', v).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file);
      await api('/api/admin/gallery', { method: 'POST', body: { dataUrl, caption: '#o-meni' } });
      toast('Fotografija za „O meni” je promijenjena.');
    } catch (err) { toast(err.message); }
    render();
  });
  $('#about-reset', v)?.addEventListener('click', async () => {
    if (!confirm('Vratiti zadanu fotografiju u „O meni”?')) return;
    for (const g of aboutPhotos) await api(`/api/admin/gallery/${g.id}`, { method: 'DELETE' });
    toast('Vraćena je zadana fotografija.');
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

// Zadana fotografija za „O meni” (dok Barbara ne doda svoju)
const ABOUT_DEFAULT = '/assets/photos/barbara-o-meni.jpg?v=2';

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
  go(['danas', 'kalendar', 'zahtjevi', 'klijentice', 'analitika', 'postavke'].includes(tab) ? tab : 'danas');
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
