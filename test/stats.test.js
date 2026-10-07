import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, chartMonths, monthlySeries, openMinutes, lateCancel, bookingsCsv } from '../server/stats.js';
import { DEFAULT_SETTINGS } from '../server/defaults.js';

const { hours, rules } = DEFAULT_SETTINGS;
const now = { date: '2026-10-15', min: 12 * 60 }; // četvrtak 12:00
const henna = { id: 'henna', name: 'Henna', price: 25, duration: 30 };
const sminka = { id: 'sminkanje', name: 'Šminkanje', price: 60, duration: 60 };
let id = 0;
const bk = (o) => ({ id: ++id, client_id: 1, name: 'Ana', phone: '063 111 222', source: 'web', duration: 30, services: [henna], total_price: 25, status: 'potvrdeno', created_at: '2026-10-01T08:00:00Z', ...o });

const bookings = [
  bk({ date: '2026-10-05', start_min: 600 }), // odrađeno
  bk({ date: '2026-10-15', start_min: 11 * 60, client_id: 2, name: 'Iva', services: [sminka, henna], total_price: 80, duration: 90, source: 'admin' }), // odrađeno (počelo)
  bk({ date: '2026-10-15', start_min: 15 * 60 }), // dogovoreno (danas poslijepodne)
  bk({ date: '2026-10-20', start_min: 600, status: 'na_cekanju' }),
  bk({ date: '2026-10-07', start_min: 600, status: 'otkazano', cancelled_by: 'klijentica', cancelled_at: '2026-10-06T20:00:00Z' }), // 6 h prije – kasno
  bk({ date: '2026-10-09', start_min: 600, status: 'otkazano', cancelled_by: 'salon', cancelled_at: '2026-10-01T10:00:00Z' }),
  bk({ date: '2026-10-08', start_min: 600, status: 'nije_dosla', client_id: 3, name: 'Mia' }),
  bk({ date: '2026-10-10', start_min: 600, status: 'odbijeno' }),
  bk({ date: '2026-09-20', start_min: 600 }), // izvan razdoblja
];

test('analitika: promet, ishodi i otkazivanja za mjesec', () => {
  const s = computeStats({ bookings, from: '2026-10-01', to: '2026-10-31', now, rules, hours, firstVisit: { 1: '2026-09-20', 2: '2026-10-15' } });
  const t = s.totals;
  assert.equal(t.revenue, 105);
  assert.equal(t.done, 2);
  assert.equal(t.avg, 52.5);
  assert.equal(t.upcoming, 1);
  assert.equal(t.upcomingRevenue, 25);
  assert.equal(t.pending, 1);
  assert.equal(t.cancelled, 2);
  assert.equal(t.cancelledByClient, 1);
  assert.equal(t.cancelledBySalon, 1);
  assert.equal(t.cancelledLate, 1);
  assert.equal(t.noShow, 1);
  assert.equal(t.rejected, 1);
  assert.equal(t.lostRevenue, 75);
  assert.equal(t.cancelRate, 2 / 6);
  assert.equal(t.clients, 2);
  assert.equal(t.newClients, 1); // Iva prvi put, Ana se vratila
  assert.equal(t.returningClients, 1);
  assert.equal(t.online, 7);
  // Šminkanje + henna za 80 KM: podjela po cjeniku 60:25
  assert.deepEqual(s.services.map((x) => [x.name, x.count, x.revenue]), [['Šminkanje', 1, 56.47], ['Henna', 2, 48.53]]);
  assert.equal(s.weekdays[3], 2); // četvrtak: odrađeno + dogovoreno
  assert.equal(s.topClients[0].name, 'Iva');
});

test('kasno otkazivanje: manje od 24 h prije termina', () => {
  const b = { date: '2026-10-07', start_min: 600, status: 'otkazano' };
  assert.equal(lateCancel({ ...b, cancelled_at: '2026-10-06T20:00:00Z' }, 24), true);
  assert.equal(lateCancel({ ...b, cancelled_at: '2026-10-05T20:00:00Z' }, 24), false);
});

test('radno vrijeme: zatvorena nedjelja i blokade', () => {
  // pon 12. – ned 18. 10.: 6 dana × 10 h
  assert.equal(openMinutes('2026-10-12', '2026-10-18', hours), 6 * 600);
  const blocks = [{ date: '2026-10-12', start_min: null }, { date: '2026-10-13', start_min: 9 * 60, end_min: 11 * 60 }];
  assert.equal(openMinutes('2026-10-12', '2026-10-18', hours, blocks), 4 * 600 + 480);
});

test('grafikon: barem 12 mjeseci, odrađeno i dogovoreno odvojeno', () => {
  const m = chartMonths('2026-10-01', '2026-10-31');
  assert.equal(m.length, 12);
  assert.equal(m[0], '2025-11');
  assert.equal(m.at(-1), '2026-10');
  const oct = monthlySeries(bookings, m, now).at(-1);
  assert.deepEqual([oct.revenue, oct.expected, oct.done, oct.cancelled], [105, 25, 2, 3]);
});

test('CSV za Excel: točka-zarez, decimalni zarez, navodnici', () => {
  const csv = bookingsCsv([bk({ date: '2026-10-05', start_min: 600, note: 'Molim; "prirodno"' })], now);
  const lines = csv.trim().split('\r\n');
  assert.ok(csv.startsWith('﻿Datum;Vrijeme'));
  assert.match(lines[1], /^05\.10\.2026\.;10:00;30;Ana;063 111 222;;Henna;25,00;Odrađeno;;/);
  assert.match(lines[1], /;"Molim; ""prirodno"""$/);
});
