// Podsjetnik „vrijeme je za novi termin”: nekoliko tjedana nakon obrva (ili druge usluge)
// klijentica dobije email s linkom na istu uslugu. Dani po kategoriji su u extras.rebookDays.
import { q } from './db.js';
import { addDays, diffDays, formatDateHr } from './time.js';
import { buildCustom, sendRaw, baseUrl } from './email.js';

const WINDOW = 3; // propušteni dani (npr. aplikacija nije radila) se još stignu poslati
const QUIET_DAYS = 14; // ista adresa najviše jedan ovakav email u dva tjedna

/** Nakon koliko dana podsjetiti za ovu rezervaciju (najkraći rok među njezinim uslugama) i za koje usluge. */
export function rebookPlan(b, rebookDays) {
  let days = 0;
  for (const s of b.services) {
    const d = Number(rebookDays?.[s.category]) || 0;
    if (d > 0 && (!days || d < days)) days = d;
  }
  if (!days) return null;
  const services = b.services.filter((s) => Number(rebookDays?.[s.category]) === days);
  return { days, services, due: addDays(b.date, days) };
}

const weeks = (days) => {
  const w = Math.round(days / 7);
  return w >= 2 ? `${w} tjedana` : `${days} dana`;
};

export function rebookEmail(b, plan, business, now) {
  const names = plan.services.map((s) => s.name).join(' + ');
  const brows = plan.services.every((s) => s.category === 'BROWS');
  const link = `${baseUrl()}/rezerviraj?usluga=${encodeURIComponent(plan.services.map((s) => s.id).join(','))}`;
  return buildCustom(brows ? 'Vrijeme je za nove obrve? 🤍' : 'Vrijeme je za novi termin? 🤍', [
    `Bok ${String(b.name).split(' ')[0]},`,
    `prošlo je ${weeks(diffDays(b.date, now.date))} od vašeg zadnjeg termina (${names}, ${formatDateHr(b.date, { withDay: false })}).${brows ? ' Obrve obično tada trebaju malo osvježenja.' : ''}`,
    'Ako želite, odaberite novi termin – usluga je već odabrana:',
    { button: 'Rezervirajte termin', href: link },
    `Ne želite ovakve podsjetnike? <a href="${baseUrl()}/podsjetnik/odjava/${b.token}">Odjavite se jednim klikom</a>.`,
    'Barbara',
  ], business);
}

/** Pošalji podsjetnike kojima je došao rok. Vraća broj poslanih. */
export async function runRebook(settings, now, send = sendRaw) {
  const rebookDays = settings.extras?.rebookDays || {};
  const all = Object.values(rebookDays).map(Number).filter((d) => d > 0);
  if (!all.length) return 0;
  const { rows } = await q(
    `SELECT b.* FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
     WHERE b.status = 'potvrdeno' AND b.rebook_sent_at IS NULL AND b.email <> ''
       AND b.date BETWEEN $1 AND $2 AND NOT coalesce(c.rebook_optout, FALSE)
     ORDER BY b.date DESC, b.start_min DESC`,
    [addDays(now.date, -(Math.max(...all) + WINDOW)), addDays(now.date, -Math.min(...all))]
  );
  let sent = 0;
  for (const b of rows) {
    const plan = rebookPlan(b, rebookDays);
    if (!plan || plan.due > now.date || diffDays(plan.due, now.date) > WINDOW) continue;
    const claimed = await q('UPDATE bookings SET rebook_sent_at = now() WHERE id = $1 AND rebook_sent_at IS NULL RETURNING id', [b.id]);
    if (!claimed.rowCount) continue;
    const cats = [...new Set(plan.services.map((s) => s.category))];
    // Preskoči ako je već rezervirala (ili je u međuvremenu bila) istu vrstu usluge, ili je nedavno dobila ovakav email
    const later = await q(
      `SELECT 1 FROM bookings x
       WHERE x.id <> $1 AND (x.client_id = $2 OR lower(x.email) = lower($3))
         AND x.status IN ('potvrdeno','na_cekanju')
         AND (x.date > $4 OR (x.date = $4 AND x.start_min > $5))
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(x.services) s WHERE s->>'category' = ANY($6))
       LIMIT 1`,
      [b.id, b.client_id, b.email, b.date, b.start_min, cats]
    );
    if (later.rowCount) continue;
    const recent = await q(
      `SELECT 1 FROM email_log WHERE kind = 'podsjetnik_termin' AND lower(to_addr) = lower($1) AND status = 'poslano'
         AND created_at > now() - make_interval(days => $2) LIMIT 1`,
      [b.email, QUIET_DAYS]
    );
    if (recent.rowCount) continue;
    const mail = rebookEmail(b, plan, settings.business, now);
    if (await send({ to: b.email, ...mail, kind: 'podsjetnik_termin', bookingId: b.id })) sent++;
  }
  return sent;
}

/** Odjava s podsjetnika (link iz emaila). */
export async function rebookOptOut(token) {
  const r = await q(
    `UPDATE clients SET rebook_optout = TRUE WHERE id = (SELECT client_id FROM bookings WHERE token = $1) RETURNING id`,
    [String(token || '')]
  );
  return r.rowCount > 0;
}
