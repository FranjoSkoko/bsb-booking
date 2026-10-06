import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daySlots, combine } from '../server/slots.js';
import { DEFAULT_SETTINGS } from '../server/defaults.js';

const { hours, rules } = DEFAULT_SETTINGS;
const now = { date: '2026-10-05', min: 8 * 60 }; // ponedjeljak 08:00
const hm = (s) => s.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);

test('šminkanje: termini na puni sat 09:00–18:00', () => {
  const s = daySlots({ date: '2026-10-13', hours, duration: 60, step: 60, busy: [], rules, now });
  assert.deepEqual(hm(s), ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
});

test('obrve: svakih 30 min do 18:30', () => {
  const s = daySlots({ date: '2026-10-13', hours, duration: 30, step: 30, busy: [], rules, now });
  assert.equal(hm(s)[0], '09:00');
  assert.equal(hm(s).at(-1), '18:30');
  assert.equal(s.length, 20);
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
  assert.equal(hm(s)[0], '12:30');
});

test('najviše 60 dana unaprijed', () => {
  assert.deepEqual(daySlots({ date: '2026-12-15', hours, duration: 30, step: 30, busy: [], rules, now }), []);
});

test('više usluga: zbroj trajanja i cijene', () => {
  const c = combine([{ duration: 60, price: 60, slot_step: 60 }, { duration: 30, price: 25, slot_step: 30 }]);
  assert.deepEqual(c, { duration: 90, price: 85, step: 60 });
});
