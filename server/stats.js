// Analitika za Barbaru: brojke za odabrano razdoblje.
// Sve se računa iz popisa rezervacija (bez baze), pa se može testirati.
import { wallMinutes, nowLocal, toMin, dayOfWeek, addDays, diffDays } from './time.js';

const round2 = (n) => Math.round(n * 100) / 100;
const sum = (list) => round2(list.reduce((a, b) => a + Number(b.total_price), 0));

const started = (b, now) => wallMinutes(b.date, b.start_min) <= wallMinutes(now.date, now.min);

/** Ishod termina: odrađeno = potvrđen termin koji je već počeo. */
export function outcome(b, now) {
  if (b.status === 'potvrdeno') return started(b, now) ? 'odradeno' : 'dogovoreno';
  if (b.status === 'na_cekanju') return started(b, now) ? 'istekao' : 'na_cekanju';
  return b.status; // otkazano, odbijeno, nije_dosla
}

export const OUTCOME_LABEL = {
  odradeno: 'Odrađeno', dogovoreno: 'Dogovoreno', na_cekanju: 'Na čekanju', istekao: 'Nije potvrđeno',
  otkazano: 'Otkazano', odbijeno: 'Odbijeno', nije_dosla: 'Nije došla',
};

/** Otkazano manje od cancelHours prije termina. */
export function lateCancel(b, cancelHours) {
  if (b.status !== 'otkazano' || !b.cancelled_at) return false;
  const c = nowLocal(new Date(b.cancelled_at));
  return wallMinutes(b.date, b.start_min) - wallMinutes(c.date, c.min) < cancelHours * 60;
}

// Cijena termina podijeljena po uslugama prema cjeniku (Barbara može ručno promijeniti ukupnu cijenu)
function serviceShares(b) {
  const list = b.services || [];
  const base = list.reduce((a, s) => a + Number(s.price || 0), 0);
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    value: base ? (Number(b.total_price) * Number(s.price || 0)) / base : Number(b.total_price) / list.length,
  }));
}

/** Minute radnog vremena u razdoblju (bez zatvorenih dana i blokada). */
export function openMinutes(from, to, hours, blocks = []) {
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const h = hours[dayOfWeek(d)];
    const open = toMin(h?.open);
    const close = toMin(h?.close);
    if (open == null || close == null || close <= open) continue;
    let mins = close - open;
    for (const bl of blocks) {
      if (bl.date !== d) continue;
      if (bl.start_min == null) { mins = 0; break; }
      mins -= Math.max(0, Math.min(close, bl.end_min) - Math.max(open, bl.start_min));
    }
    total += Math.max(0, mins);
  }
  return total;
}

const nextMonth = (m) => {
  let [y, mo] = m.split('-').map(Number);
  if (++mo > 12) { mo = 1; y++; }
  return `${y}-${String(mo).padStart(2, '0')}`;
};
const prevMonth = (m) => {
  let [y, mo] = m.split('-').map(Number);
  if (--mo < 1) { mo = 12; y--; }
  return `${y}-${String(mo).padStart(2, '0')}`;
};

/** Mjeseci za grafikon prometa: barem 12 (unatrag od kraja razdoblja), najviše 36. */
export function chartMonths(from, to) {
  const list = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = nextMonth(m)) list.push(m);
  while (list.length < 12) list.unshift(prevMonth(list[0]));
  return list.slice(-36);
}

export function monthlySeries(bookings, months, now) {
  const rows = Object.fromEntries(months.map((m) => [m, { month: m, revenue: 0, expected: 0, done: 0, cancelled: 0 }]));
  for (const b of bookings) {
    const r = rows[b.date.slice(0, 7)];
    if (!r) continue;
    const o = outcome(b, now);
    if (o === 'odradeno') { r.revenue += Number(b.total_price); r.done++; }
    else if (o === 'dogovoreno') r.expected += Number(b.total_price);
    else if (o === 'otkazano' || o === 'nije_dosla') r.cancelled++;
  }
  return months.map((m) => ({ ...rows[m], revenue: round2(rows[m].revenue), expected: round2(rows[m].expected) }));
}

const clientKey = (b) => (b.client_id ? `c${b.client_id}` : `n${String(b.name).toLowerCase()}|${b.phone}`);

/**
 * Brojke za razdoblje [from, to].
 * firstVisit: { client_id: 'YYYY-MM-DD' } – datum prvog odrađenog termina svake klijentice (od početka).
 */
export function computeStats({ bookings, from, to, now, rules = {}, hours = {}, blocks = [], firstVisit = {} }) {
  const list = bookings.filter((b) => b.date >= from && b.date <= to);
  const by = Object.fromEntries(Object.keys(OUTCOME_LABEL).map((k) => [k, []]));
  for (const b of list) by[outcome(b, now)].push(b);
  const done = by.odradeno;
  const held = [...done, ...by.dogovoreno]; // termini koji zauzimaju (ili su zauzeli) vrijeme
  const booked = done.length + by.dogovoreno.length + by.otkazano.length + by.nije_dosla.length;
  const revenue = sum(done);
  const cancelHours = rules.cancelHours ?? 24;

  // Usluge (samo odrađeni termini)
  const svc = new Map();
  for (const b of done) {
    for (const s of serviceShares(b)) {
      const row = svc.get(s.id) || { id: s.id, name: s.name, count: 0, revenue: 0 };
      row.count++;
      row.revenue += s.value;
      svc.set(s.id, row);
    }
  }

  // Dani u tjednu (pon … ned) i sati početka
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const hourly = {};
  for (const b of held) {
    weekdays[(dayOfWeek(b.date) + 6) % 7]++;
    const h = Math.floor(b.start_min / 60);
    hourly[h] = (hourly[h] || 0) + 1;
  }

  // Klijentice
  const clients = new Map();
  for (const b of done) {
    const k = clientKey(b);
    const c = clients.get(k) || { client_id: b.client_id, name: b.name, visits: 0, revenue: 0 };
    c.visits++;
    c.revenue += Number(b.total_price);
    clients.set(k, c);
  }
  const served = [...clients.values()];
  const newClients = served.filter((c) => c.client_id && firstVisit[c.client_id] && firstVisit[c.client_id] >= from && firstVisit[c.client_id] <= to).length;

  // Online rezervacije i koliko unaprijed rezerviraju
  const web = list.filter((b) => b.source === 'web');
  const lead = web.filter((b) => b.created_at).map((b) => Math.max(0, diffDays(nowLocal(new Date(b.created_at)).date, b.date)));

  const bookedMin = held.reduce((a, b) => a + b.duration, 0);
  const openMin = openMinutes(from, to, hours, blocks);

  return {
    from,
    to,
    totals: {
      revenue,
      done: done.length,
      avg: done.length ? round2(revenue / done.length) : 0,
      upcoming: by.dogovoreno.length,
      upcomingRevenue: sum(by.dogovoreno),
      pending: by.na_cekanju.length,
      expired: by.istekao.length,
      cancelled: by.otkazano.length,
      cancelledByClient: by.otkazano.filter((b) => b.cancelled_by === 'klijentica').length,
      cancelledBySalon: by.otkazano.filter((b) => b.cancelled_by === 'salon').length,
      cancelledLate: by.otkazano.filter((b) => lateCancel(b, cancelHours)).length,
      cancelRate: booked ? by.otkazano.length / booked : 0,
      noShow: by.nije_dosla.length,
      noShowRate: done.length + by.nije_dosla.length ? by.nije_dosla.length / (done.length + by.nije_dosla.length) : 0,
      lostRevenue: round2(sum(by.otkazano) + sum(by.nije_dosla)),
      rejected: by.odbijeno.length,
      clients: served.length,
      newClients,
      returningClients: served.length - newClients,
      repeatClients: served.filter((c) => c.visits > 1).length,
      online: web.length,
      onlineShare: list.length ? web.length / list.length : 0,
      leadDays: lead.length ? Math.round((lead.reduce((a, b) => a + b, 0) / lead.length) * 10) / 10 : null,
      occupancy: openMin ? Math.min(1, bookedMin / openMin) : null,
      bookedHours: round2(bookedMin / 60),
      openHours: round2(openMin / 60),
    },
    services: [...svc.values()].map((s) => ({ ...s, revenue: round2(s.revenue) })).sort((a, b) => b.revenue - a.revenue || b.count - a.count),
    weekdays,
    hourly,
    topClients: served.sort((a, b) => b.revenue - a.revenue || b.visits - a.visits).slice(0, 5).map((c) => ({ ...c, revenue: round2(c.revenue) })),
  };
}

// ---------- CSV za Excel (hrvatske postavke: točka-zarez i decimalni zarez) ----------
const cell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hrDate = (ymd) => ymd.split('-').reverse().join('.') + '.';

export function bookingsCsv(bookings, now) {
  const head = ['Datum', 'Vrijeme', 'Trajanje (min)', 'Klijentica', 'Mobitel', 'Email', 'Usluge', 'Cijena (KM)', 'Ishod', 'Otkazala', 'Rezervirano', 'Izvor', 'Napomena'];
  const rows = bookings.map((b) => {
    const created = b.created_at ? nowLocal(new Date(b.created_at)) : null;
    return [
      hrDate(b.date),
      hhmm(b.start_min),
      b.duration,
      b.name,
      b.phone,
      b.email,
      (b.services || []).map((s) => s.name).join(' + '),
      Number(b.total_price).toFixed(2).replace('.', ','),
      OUTCOME_LABEL[outcome(b, now)],
      b.status === 'otkazano' ? ({ klijentica: 'klijentica', salon: 'salon' }[b.cancelled_by] || '') : '',
      created ? `${hrDate(created.date)} ${hhmm(created.min)}` : '',
      b.source === 'web' ? 'online' : 'upisala Barbara',
      b.note,
    ];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
