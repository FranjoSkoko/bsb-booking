// Praznici kad salon ne radi (Federacija BiH i katolički blagdani).
// Barbara u Postavkama bira koje od njih zatvara; null = svi s popisa.
import { addDays } from './time.js';

export const HOLIDAYS = [
  { k: 'nova_godina', name: 'Nova godina', dates: ['01-01', '01-02'] },
  { k: 'sveta_tri_kralja', name: 'Sveta tri kralja', dates: ['01-06'] },
  { k: 'dan_nezavisnosti', name: 'Dan nezavisnosti', dates: ['03-01'] },
  { k: 'uskrs', name: 'Uskrs', easter: 0 },
  { k: 'uskrsni_ponedjeljak', name: 'Uskrsni ponedjeljak', easter: 1 },
  { k: 'praznik_rada', name: 'Praznik rada', dates: ['05-01', '05-02'] },
  { k: 'tijelovo', name: 'Tijelovo', easter: 60 },
  { k: 'velika_gospa', name: 'Velika Gospa', dates: ['08-15'] },
  { k: 'svi_sveti', name: 'Svi sveti', dates: ['11-01'] },
  { k: 'dan_drzavnosti', name: 'Dan državnosti', dates: ['11-25'] },
  { k: 'bozic', name: 'Božić', dates: ['12-25'] },
  { k: 'sveti_stjepan', name: 'Sveti Stjepan', dates: ['12-26'] },
];

/** Uskrs (zapadni, gregorijanski kalendar) – Meeus/Jones/Butcher. */
export function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const cache = new Map();

/** Svi praznici u godini: [{ date, k, name }] po datumu. */
export function holidaysForYear(year) {
  if (cache.has(year)) return cache.get(year);
  const e = easter(year);
  const out = [];
  for (const h of HOLIDAYS) {
    const dates = h.dates ? h.dates.map((md) => `${year}-${md}`) : [addDays(e, h.easter)];
    for (const date of dates) out.push({ date, k: h.k, name: h.name });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  cache.set(year, out);
  return out;
}

/** Naziv praznika ako je tog dana salon zatvoren, inače null. selected: null = svi, inače popis ključeva. */
export function holidayOn(date, selected = null) {
  const hit = holidaysForYear(Number(date.slice(0, 4))).find((h) => h.date === date);
  if (!hit) return null;
  if (Array.isArray(selected) && !selected.includes(hit.k)) return null;
  return hit.name;
}

/** Praznici u razdoblju (uključivo): { 'YYYY-MM-DD': naziv } */
export function holidaysBetween(from, to, selected = null) {
  const out = {};
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of holidaysForYear(y)) {
      if (h.date < from || h.date > to) continue;
      if (Array.isArray(selected) && !selected.includes(h.k)) continue;
      out[h.date] = h.name;
    }
  }
  return out;
}

/** Zatvoreni praznici prema postavkama (prazno kad je mogućnost isključena). */
export const closedHolidays = (settings, from, to) =>
  (settings.features?.holidays ? holidaysBetween(from, to, settings.extras?.holidays ?? null) : {});
