import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daySlots, combine } from '../server/slots.js';
import { DEFAULT_SETTINGS } from '../server/defaults.js';

const { hours, rules } = DEFAULT_SETTINGS;
const now = { date: '2026-10-05', min: 8 * 60 }; // ponedjeljak 08:00
const hm = (s) => s.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

test('šminkanje: 08:30–11:30 i 16:30–19:30, ništa u pauzi', () => {
  const s = daySlots({ date: '2026-10-13', hours, duration: 60, step: 60, busy: [], rules, now });
  assert.deepEqual(hm(s), ['08:30', '09:30', '10:30', '11:30', '16:30', '17:30', '18:30', '19:30']);
});

test('obrve: svakih 30 min, zadnji jutarnji 12:00, zadnji večernji 20:00', () => {
  const s = daySlots({ date: '2026-10-13', hours, duration: 30, step: 30, busy: [], rules, now });
  assert.equal(hm(s)[0], '08:30');
  assert.ok(hm(s).includes('12:00') && !hm(s).includes('12:30') && !hm(s).includes('16:00'));
  assert.equal(hm(s).at(-1), '20:00');
  assert.equal(s.length, 16);
});

test('šminkanje u 19:30 zatvara obrve u 20:00 i obrnuto', () => {
  const brows = daySlots({ date: '2026-10-13', hours, duration: 30, step: 30, busy: [{ start: 1170, end: 1230 }], rules, now });
  assert.ok(!hm(brows).includes('19:30') && !hm(brows).includes('20:00'));
  assert.ok(hm(brows).includes('19:00'));
  const makeup = daySlots({ date: '2026-10-13', hours, duration: 60, step: 60, busy: [{ start: 1200, end: 1230 }], rules, now });
  assert.ok(!hm(makeup).includes('19:30'));
  assert.ok(hm(makeup).includes('18:30'));
});

test('bez pauze: cijeli dan', () => {
  const plain = { ...hours, 2: { open: '09:00', close: '19:00' } };
  const s = daySlots({ date: '2026-10-13', hours: plain, duration: 60, step: 60, busy: [], rules, now });
  assert.equal(s.length, 10);
});

test('nakon šminkanja u 10:00 nema termina u 10:30', () => {
  const s = daySlots({ date: '2026-10-13', hours, duration: 30, step: 30, busy: [{ start: 600, end: 660 }], rules, now });
  assert.ok(!hm(s).includes('10:00'));
  assert.ok(!hm(s).includes('10:30'));
  assert.ok(hm(s).includes('11:00'));
});

test('nedjeljom nema termina', () => {
  assert.deepEqual(daySlots({ date: '2026-10-11', hours, duration: 30, step: 30, busy: [], rules, now }), []);
});

test('minimalno 2 h unaprijed', () => {
  const s = daySlots({ date: '2026-10-05', hours, duration: 30, step: 30, busy: [], rules, now: { date: '2026-10-05', min: 10 * 60 + 10 } });
  assert.equal(hm(s)[0], '16:30');
});

test('najviše 60 dana unaprijed', () => {
  assert.deepEqual(daySlots({ date: '2026-12-15', hours, duration: 30, step: 30, busy: [], rules, now }), []);
});

test('više usluga: zbroj trajanja i cijene', () => {
  const c = combine([{ duration: 60, price: 60, slot_step: 60 }, { duration: 30, price: 25, slot_step: 30 }]);
  assert.deepEqual(c, { duration: 90, price: 85, step: 60 });
});
