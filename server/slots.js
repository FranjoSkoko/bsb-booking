import { toMin, nowLocal, addDays, dayOfWeek, diffDays } from './time.js';

// Statusi koji zauzimaju termin
export const BUSY_STATUSES = ['na_cekanju', 'potvrdeno'];

/** Ukupno trajanje, cijena i korak termina za odabrane usluge. */
export function combine(services) {
  return {
    duration: services.reduce((a, s) => a + s.duration, 0),
    price: services.reduce((a, s) => a + Number(s.price), 0),
    step: Math.max(...services.map((s) => s.slot_step || 30)),
  };
}

/**
 * Slobodni termini za jedan dan.
 * busy: [{start, end}] u minutama (rezervacije + blokade)
 */
/**
 * Radni dijelovi dana u minutama, npr. [[510, 750], [990, 1230]] za 08:30–12:30 i 16:30–20:30.
 * Pauza (breakFrom–breakTo) je neobavezna.
 */
export function dayIntervals(dh) {
  if (!dh) return [];
  const open = toMin(dh.open);
  const close = toMin(dh.close);
  if (open == null || close == null || close <= open) return [];
  const bf = toMin(dh.breakFrom);
  const bt = toMin(dh.breakTo);
  if (bf == null || bt == null || !(open < bf && bf < bt && bt < close)) return [[open, close]];
  return [[open, bf], [bt, close]];
}

/** Spoji radne dijelove dana i dodatno otvorena vremena u nepreklapajuće intervale. */
export function mergeIntervals(list) {
  const out = [];
  for (const [s, e] of [...list].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** extra: dodatno otvorena vremena za taj dan, npr. [[750, 870]] = 12:30–14:30 */
export function daySlots({ date, hours, duration, step, busy, rules, extra = [], now = nowLocal() }) {
  const parts = mergeIntervals([...dayIntervals(hours[dayOfWeek(date)]), ...extra]);
  if (!parts.length) return [];

  const ahead = diffDays(now.date, date);
  if (ahead < 0 || ahead > rules.maxDaysAhead) return [];

  const minNotice = rules.minNoticeHours * 60;
  const buffer = rules.bufferMin || 0;

  const out = [];
  // Termin mora cijeli stati u jedan dio dana (prije ili poslije pauze); preklapanje s
  // postojećom rezervacijom ili blokadom zatvara termin (npr. šminkanje u 19:30 zatvara obrve u 20:00).
  for (const [open, close] of parts) {
    for (let t = open; t + duration <= close; t += step) {
      // minimalni razmak od trenutnog vremena
      if (ahead * 1440 + t - now.min < minNotice) continue;
      const clash = busy.some((b) => t < b.end + buffer && b.start < t + duration + buffer);
      if (!clash) out.push(t);
    }
  }
  return out;
}

/** Popis datuma (od danas) na koje se može rezervirati. */
export function bookableDates(rules, now = nowLocal()) {
  const out = [];
  for (let i = 0; i <= rules.maxDaysAhead; i++) out.push(addDays(now.date, i));
  return out;
}
