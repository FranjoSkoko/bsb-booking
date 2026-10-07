import { toHHMM } from './time.js';

export const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Sarajevo',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

export const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
export const stamp = (date, min) => `${date.replace(/-/g, '')}T${toHHMM(min).replace(':', '')}00`;

// Redovi duži od 75 bajtova lome se u nastavke (RFC 5545), bez rezanja slova poput "š" na pola
export function fold(line) {
  const out = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > limit) {
      out.push(cur);
      cur = '';
      limit = 74; // nastavak počinje razmakom
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const STATUS = { potvrdeno: 'CONFIRMED', na_cekanju: 'TENTATIVE', otkazano: 'CANCELLED', odbijeno: 'CANCELLED' };

export function bookingIcs(b, business, baseUrl) {
  const names = b.services.map((s) => s.name).join(' + ');
  const location = [business.address, business.city].filter(Boolean).join(', ');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Barbara Skoko Beauty//Rezervacije//HR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...VTIMEZONE,
    'BEGIN:VEVENT',
    `UID:bsb-${b.id}-${b.token.slice(0, 8)}@barbaraskokobeauty`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `STATUS:${STATUS[b.status] || 'CONFIRMED'}`,
    `DTSTART;TZID=Europe/Sarajevo:${stamp(b.date, b.start_min)}`,
    `DTEND;TZID=Europe/Sarajevo:${stamp(b.date, b.start_min + b.duration)}`,
    `SUMMARY:${esc(`${names} – Barbara Skoko Beauty`)}`,
    `LOCATION:${esc(location)}`,
    `DESCRIPTION:${esc(`Vaš termin: ${names}. Detalji: ${baseUrl}/rezervacija/${b.token}`)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Termin kod Barbare',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}

const utcStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

/**
 * Pretplata na kalendar za Barbaru (iPhone / Google kalendar): svi dogovoreni termini i blokade.
 * Kalendar ga sam osvježava; otkazani termini jednostavno nestanu.
 */
export function calendarFeedIcs({ bookings, blocks = [], business, baseUrl }) {
  const events = bookings.map((b) => {
    const names = b.services.map((s) => s.name).join(' + ');
    const pending = b.status === 'na_cekanju';
    const info = [
      `${names} · ${Number(b.total_price).toLocaleString('hr-HR')} KM`,
      [b.phone, b.email].filter(Boolean).join(' · '),
      b.note ? `Napomena: ${b.note}` : '',
      b.admin_note ? `Bilješka: ${b.admin_note}` : '',
      pending ? 'Zahtjev još nije potvrđen.' : '',
      `${baseUrl}/admin`,
    ].filter(Boolean).join('\n');
    return [
      'BEGIN:VEVENT',
      `UID:bsb-termin-${b.id}@barbaraskokobeauty`,
      `DTSTAMP:${utcStamp()}`,
      `STATUS:${pending ? 'TENTATIVE' : 'CONFIRMED'}`,
      `DTSTART;TZID=Europe/Sarajevo:${stamp(b.date, b.start_min)}`,
      `DTEND;TZID=Europe/Sarajevo:${stamp(b.date, b.start_min + b.duration)}`,
      `SUMMARY:${esc(`${pending ? '(na čekanju) ' : ''}${b.name} · ${names}`)}`,
      `DESCRIPTION:${esc(info)}`,
      'END:VEVENT',
    ];
  });
  const blockEvents = blocks.map((bl) => {
    const allDay = bl.start_min == null;
    const next = new Date(Date.parse(bl.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    return [
      'BEGIN:VEVENT',
      `UID:bsb-blokada-${bl.id}@barbaraskokobeauty`,
      `DTSTAMP:${utcStamp()}`,
      allDay ? `DTSTART;VALUE=DATE:${bl.date.replace(/-/g, '')}` : `DTSTART;TZID=Europe/Sarajevo:${stamp(bl.date, bl.start_min)}`,
      allDay ? `DTEND;VALUE=DATE:${next.replace(/-/g, '')}` : `DTEND;TZID=Europe/Sarajevo:${stamp(bl.date, bl.end_min)}`,
      `SUMMARY:${esc(`Blokirano${bl.reason ? ` · ${bl.reason}` : ''}`)}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    ];
  });
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Barbara Skoko Beauty//Kalendar termina//HR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${business.name || 'BSB'} – termini`)}`,
    'X-WR-TIMEZONE:Europe/Sarajevo',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    ...VTIMEZONE,
    ...events.flat(),
    ...blockEvents.flat(),
    'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}
