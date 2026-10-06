// Sve vrijeme u aplikaciji je lokalno vrijeme salona (Europe/Sarajevo).
// Datumi su 'YYYY-MM-DD', vrijeme u minutama od ponoći.

export const TZ = 'Europe/Sarajevo';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function nowLocal(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { date: ymd, min: Number(p.hour) * 60 + Number(p.minute), dow: dayOfWeek(ymd) };
}

export function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}

export function addDays(ymd, n) {
  return new Date(parseYmd(ymd) + n * 86400000).toISOString().slice(0, 10);
}

export function dayOfWeek(ymd) {
  return new Date(parseYmd(ymd)).getUTCDay();
}

export function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

// "Zidni" sat kao broj minuta – dovoljno za usporedbe (podsjetnik 24 h prije itd.)
export function wallMinutes(ymd, min) {
  return parseYmd(ymd) / 60000 + min;
}

export function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const DANI = ['nedjelja', 'ponedjeljak', 'utorak', 'srijeda', 'četvrtak', 'petak', 'subota'];
const MJESECI = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja', 'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca'];

export function formatDateHr(ymd, { withDay = true } = {}) {
  const t = new Date(parseYmd(ymd));
  const s = `${t.getUTCDate()}. ${MJESECI[t.getUTCMonth()]} ${t.getUTCFullYear()}.`;
  return withDay ? `${DANI[t.getUTCDay()]}, ${s}` : s;
}
