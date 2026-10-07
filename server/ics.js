import { toHHMM } from './time.js';

const VTIMEZONE = [
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

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
const stamp = (date, min) => `${date.replace(/-/g, '')}T${toHHMM(min).replace(':', '')}00`;

// Redovi duži od 75 bajtova lome se u nastavke (RFC 5545), bez rezanja slova poput "š" na pola
function fold(line) {
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
