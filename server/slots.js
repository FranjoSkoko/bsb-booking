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
export function daySlots({ date, hours, duration, step, busy, rules, now = nowLocal() }) {
  const dh = hours[dayOfWeek(date)];
  if (!dh) return [];
  const open = toMin(dh.open);
  const close = toMin(dh.close);
  if (open == null || close == null || close <= open) return [];

  const ahead = diffDays(now.date, date);
  if (ahead < 0 || ahead > rules.maxDaysAhead) return [];

  const minNotice = rules.minNoticeHours * 60;
  const buffer = rules.bufferMin || 0;

  const out = [];
  for (let t = open; t + duration <= close; t += step) {
    // minimalni razmak od trenutnog vremena
    if (ahead * 1440 + t - now.min < minNotice) continue;
    const clash = busy.some((b) => t < b.end + buffer && b.start < t + duration + buffer);
    if (!clash) out.push(t);
  }
  return out;
}

/** Popis datuma (od danas) na koje se može rezervirati. */
export function bookableDates(rules, now = nowLocal()) {
  const out = [];
  for (let i = 0; i <= rules.maxDaysAhead; i++) out.push(addDays(now.date, i));
  return out;
}
