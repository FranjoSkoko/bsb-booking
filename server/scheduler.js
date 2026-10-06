import { q, getSettings, saveSetting } from './db.js';
import { nowLocal, addDays, wallMinutes, toHHMM, formatDateHr } from './time.js';
import { rowToBooking } from './bookings.js';
import { sendBookingEmail, sendRaw, buildCustom, adminEmail, baseUrl } from './email.js';

let running = false;

/** Podsjetnici (24 h prije), zahvale (dan nakon) i jutarnji pregled za Barbaru. */
export async function runScheduledJobs(now = nowLocal()) {
  if (running) return { skipped: true };
  running = true;
  const result = { reminders: 0, thanks: 0, summary: false };
  try {
    const settings = await getSettings();
    const biz = settings.business;
    const nowWall = wallMinutes(now.date, now.min);

    if (settings.notify.reminders) {
      const { rows } = await q(
        `SELECT * FROM bookings WHERE status = 'potvrdeno' AND reminder_sent_at IS NULL
           AND email <> '' AND date BETWEEN $1 AND $2
           AND (confirmed_at IS NULL OR confirmed_at < now() - interval '3 hours')`,
        [now.date, addDays(now.date, 2)]
      );
      for (const r of rows) {
        const left = wallMinutes(r.date, r.start_min) - nowWall;
        if (left <= 0 || left > 24 * 60) continue;
        const claimed = await q('UPDATE bookings SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id', [r.id]);
        if (!claimed.rowCount) continue;
        await sendBookingEmail('podsjetnik', rowToBooking(r), biz, { extra: { kada: r.date === now.date ? 'danas' : 'sutra' } });
        result.reminders++;
      }
    }

    if (settings.notify.thanks && now.min >= 10 * 60) {
      const { rows } = await q(
        `SELECT * FROM bookings WHERE status = 'potvrdeno' AND thanks_sent_at IS NULL AND email <> ''
           AND date < $1 AND date >= $2`,
        [now.date, addDays(now.date, -3)]
      );
      for (const r of rows) {
        const claimed = await q('UPDATE bookings SET thanks_sent_at = now() WHERE id = $1 AND thanks_sent_at IS NULL RETURNING id', [r.id]);
        if (!claimed.rowCount) continue;
        await sendBookingEmail('hvala', rowToBooking(r), biz);
        result.thanks++;
      }
    }

    if (settings.notify.dailySummary && now.min >= 7 * 60 && settings.meta.lastSummary !== now.date) {
      await saveSetting('meta', { ...settings.meta, lastSummary: now.date });
      const today = await q(
        `SELECT * FROM bookings WHERE date = $1 AND status = ANY($2) ORDER BY start_min`,
        [now.date, ['potvrdeno', 'na_cekanju']]
      );
      const pending = await q(`SELECT count(*)::int AS n FROM bookings WHERE status = 'na_cekanju' AND date >= $1`, [now.date]);
      if (today.rowCount || pending.rows[0].n) {
        const list = today.rows.map((r) => {
          const b = rowToBooking(r);
          return `${toHHMM(b.start_min)} · ${b.services.map((s) => s.name).join(' + ')} · ${b.name}${b.status === 'na_cekanju' ? ' (na čekanju)' : ''}`;
        });
        const mail = buildCustom(`Danas: ${today.rowCount} ${today.rowCount === 1 ? 'termin' : 'termina'}`, [
          `Dobro jutro, Barbara. Pregled za ${formatDateHr(now.date)}:`,
          list.length ? { box: list } : 'Danas nema zakazanih termina.',
          pending.rows[0].n ? `Zahtjeva na čekanju: ${pending.rows[0].n}.` : '',
          { button: 'Otvori administraciju', href: `${baseUrl()}/admin` },
        ].filter(Boolean), biz);
        await sendRaw({ to: adminEmail(biz), ...mail, kind: 'dnevni_pregled' });
        result.summary = true;
      }
    }
  } catch (err) {
    console.error('[raspored] greška:', err);
    result.error = err.message;
  } finally {
    running = false;
  }
  return result;
}

export function startScheduler() {
  const tick = () => runScheduledJobs().catch((e) => console.error(e));
  setTimeout(tick, 15_000);
  setInterval(tick, 5 * 60_000);
}
