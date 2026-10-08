import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easter, holidayOn, holidaysBetween, closedHolidays } from '../server/holidays.js';

// Moduli niže učitavaju bazu (bez spajanja) – treba im samo adresa
process.env.DATABASE_URL ||= 'postgres://test@localhost:1/test';
const { rebookPlan } = await import('../server/rebook.js');
const { normalizeCode, newCode, addMonths, bankMessage, bankWhatsApp } = await import('../server/vouchers.js');
const { shortName } = await import('../server/reviews.js');

test('Uskrs (zapadni) za više godina', () => {
  assert.equal(easter(2026), '2026-04-05');
  assert.equal(easter(2027), '2027-03-28');
  assert.equal(easter(2028), '2028-04-16');
  assert.equal(easter(2030), '2030-04-21');
});

test('praznici: Tijelovo, dvodnevni praznici i odabir', () => {
  assert.equal(holidayOn('2026-06-04'), 'Tijelovo'); // Uskrs + 60
  assert.equal(holidayOn('2026-04-06'), 'Uskrsni ponedjeljak');
  assert.equal(holidayOn('2027-01-02'), 'Nova godina');
  assert.equal(holidayOn('2026-05-02'), 'Praznik rada');
  assert.equal(holidayOn('2026-11-25'), 'Dan državnosti');
  assert.equal(holidayOn('2026-11-24'), null);
  assert.equal(holidayOn('2026-12-25', ['sveti_stjepan']), null);
  assert.equal(holidayOn('2026-12-26', ['sveti_stjepan']), 'Sveti Stjepan');
  assert.deepEqual(Object.keys(holidaysBetween('2026-12-20', '2027-01-07')), ['2026-12-25', '2026-12-26', '2027-01-01', '2027-01-02', '2027-01-06']);
  assert.deepEqual(closedHolidays({ features: { holidays: false }, extras: {} }, '2026-12-20', '2026-12-31'), {});
});

test('podsjetnik za novi termin: najkraći rok među uslugama', () => {
  const b = { date: '2026-09-01', services: [{ id: 'sminkanje', category: 'MAKEUP' }, { id: 'henna', category: 'BROWS' }] };
  const p = rebookPlan(b, { BROWS: 35, FACE: 28, MAKEUP: 0 });
  assert.equal(p.days, 35);
  assert.equal(p.due, '2026-10-06');
  assert.deepEqual(p.services.map((s) => s.id), ['henna']);
  assert.equal(rebookPlan({ date: '2026-09-01', services: [{ id: 'sminkanje', category: 'MAKEUP' }] }, { MAKEUP: 0 }), null);
});

test('poklon bon: kod, upis koda i rok', () => {
  assert.match(newCode(), /^BSB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCode('bsb 7k2m q9xa'), 'BSB-7K2M-Q9XA');
  assert.equal(normalizeCode('7K2MQ9XA'), 'BSB-7K2M-Q9XA');
  assert.equal(normalizeCode('BSB-7K2M'), '');
  assert.equal(addMonths('2026-10-07', 12), '2027-10-07');
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
});

test('recenzija: ime i početno slovo prezimena', () => {
  assert.equal(shortName('Ana Anić'), 'Ana A.');
  assert.equal(shortName('Ana Marija Šimić'), 'Ana Š.');
  assert.equal(shortName('Iva'), 'Iva');
  assert.equal(shortName(''), 'Klijentica');
});

test('bon: poruka s podacima za uplatu ide na kupčev WhatsApp', () => {
  const v = { buyer_name: 'Ana Primjer', buyer_phone: '063 222 333', amount: '50.00', code: 'BSB-7K2M-Q9XA' };
  const msg = bankMessage(v, 'Broj računa: 1234');
  assert.match(msg, /^Bok Ana, hvala na narudžbi poklon bona od 50 KM!/);
  assert.match(msg, /Broj računa: 1234\nIznos: 50 KM\nOpis plaćanja: Poklon bon BSB-7K2M-Q9XA/);
  assert.ok(bankWhatsApp(v, 'x').startsWith('https://wa.me/38763222333?text=Bok%20Ana'));
  assert.equal(bankWhatsApp({ ...v, buyer_phone: '' }, 'x'), '');
});
