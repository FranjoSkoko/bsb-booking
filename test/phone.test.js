import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneDigits, telHref, waHref } from '../server/phone.js';

test('broj mobitela u svim uobičajenim oblicima', () => {
  assert.equal(phoneDigits('+387 63 674 074'), '38763674074');
  assert.equal(phoneDigits('063 674 074'), '38763674074');
  assert.equal(phoneDigits('00387 63 674 074'), '38763674074');
  assert.equal(phoneDigits('63 674 074'), '38763674074');
  assert.equal(phoneDigits('+385 91 234 5678'), '385912345678');
  assert.equal(phoneDigits('0038591234567'), '38591234567');
  assert.equal(phoneDigits(''), '');
});

test('tel: i WhatsApp linkovi', () => {
  assert.equal(telHref('063 674 074'), 'tel:+38763674074');
  assert.equal(waHref('00387 63 900 106'), 'https://wa.me/38763900106');
  assert.equal(waHref(''), '');
});
