import nodemailer from 'nodemailer';
import { q } from './db.js';
import { formatDateHr, toHHMM } from './time.js';
import { bookingIcs } from './ics.js';
import { actionLink } from './auth.js';
import { baseUrl } from './config.js';

export { baseUrl };

let transport = null;
export function emailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}
function getTransport() {
  if (!emailConfigured()) return null;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

export const adminEmail = (business) => process.env.ADMIN_EMAIL || business.email;

// ---------- predlošci (03_Podaci/Email_predlosci) ----------

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mapsUrl(business) {
  const q = business.mapQuery || [business.address, business.city].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

const clean = (s) => String(s ?? '').replace(/[<>]/g, '');

function vars(b, business) {
  const base = baseUrl();
  return {
    ime: clean(b.name).split(' ')[0],
    punoIme: clean(b.name),
    usluga: b.services.map((s) => s.name).join(' + '),
    datum: formatDateHr(b.date),
    vrijeme: toHHMM(b.start_min),
    trajanje: b.duration,
    cijena: Number(b.total_price).toLocaleString('hr-HR'),
    telefon: clean(b.phone),
    email: clean(b.email),
    napomena: clean(b.note) || '–',
    lokacija: [business.address, business.city].filter(Boolean).join(', '),
    link_otkazivanje: `${base}/rezervacija/${b.token}`,
    link_karta: mapsUrl(business),
    link_rezervacija: `${base}/#rezervacija`,
  };
}

// Svaki predložak vraća { subject, lines } – lines: tekst ili {button, href} ili {box: [...]}
const TEMPLATES = {
  zaprimljen: (v) => ({
    subject: 'Zaprimili smo vaš zahtjev za termin 🤍',
    lines: [
      `Bok ${v.ime},`,
      'hvala vam na rezervaciji! Vaš zahtjev za termin je zaprimljen:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme} (${v.trajanje} min)`, `${v.cijena} KM`] },
      'Termin ću potvrditi u najkraćem mogućem roku – javit ću vam se emailom.',
      { button: 'Pogledajte svoju rezervaciju', href: v.link_otkazivanje },
      'Do skorog viđenja,<br>Barbara',
    ],
  }),
  novi_zahtjev: (v, extra) => ({
    subject: `Novi zahtjev: ${v.usluga} – ${v.datum} u ${v.vrijeme}`,
    lines: [
      { box: [`${v.usluga} · ${v.cijena} KM`, `${v.datum} u ${v.vrijeme} (${v.trajanje} min)`, `${v.punoIme} · ${v.telefon} · ${v.email}`, `Napomena: ${v.napomena}`] },
      { button: 'Potvrdi', href: extra.confirmUrl },
      { button: 'Odbij', href: extra.declineUrl, secondary: true },
      `<a href="${extra.adminUrl}">Otvori administraciju</a>`,
    ],
  }),
  potvrden: (v) => ({
    subject: 'Vaš termin je potvrđen ✨',
    lines: [
      `Bok ${v.ime},`,
      'vaš termin je potvrđen:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme}`, `📍 ${v.lokacija}`] },
      `<a href="${v.link_karta}">Upute do salona (Google karte)</a>`,
      'Mali savjet: na termin dođite čistog lica, a večer prije nanesite hidratantnu kremu.',
      'Termin možete dodati u svoj kalendar pomoću priložene datoteke.',
      { button: 'Detalji ili otkazivanje', href: v.link_otkazivanje },
      'Veselim se!<br>Barbara',
    ],
  }),
  promijenjen: (v) => ({
    subject: 'Vaš termin je promijenjen',
    lines: [
      `Bok ${v.ime},`,
      'kako smo se dogovorile, vaš termin je pomaknut. Novi termin:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme}`, `📍 ${v.lokacija}`] },
      `<a href="${v.link_karta}">Upute do salona (Google karte)</a>`,
      'U privitku je ažurirani termin za vaš kalendar.',
      { button: 'Detalji ili otkazivanje', href: v.link_otkazivanje },
      'Barbara',
    ],
  }),
  podsjetnik: (v, extra) => ({
    subject: `Vidimo se ${extra.kada} u ${v.vrijeme} 🤍`,
    lines: [
      `Bok ${v.ime},`,
      `samo kratki podsjetnik – ${extra.kada} imate termin: ${v.usluga} u ${v.vrijeme}.`,
      { box: [`📍 ${v.lokacija}`] },
      `<a href="${v.link_karta}">Upute do salona (Google karte)</a>`,
      `Ako se nešto promijenilo, javite mi na ${extra.phone}.`,
      'Barbara',
    ],
  }),
  odbijen: (v, extra) => ({
    subject: 'Vaš termin – prijedlog novog vremena',
    lines: [
      `Bok ${v.ime},`,
      `nažalost, termin ${v.datum} u ${v.vrijeme} ne mogu potvrditi. Odaberite drugi slobodan termin ili mi pišite na Instagramu ${extra.instagram}.`,
      { button: 'Odaberite novi termin', href: v.link_rezervacija },
      'Hvala na razumijevanju,<br>Barbara',
    ],
  }),
  otkazan: (v) => ({
    subject: 'Termin je otkazan',
    lines: [
      `Bok ${v.ime},`,
      `vaš termin ${v.usluga} · ${v.datum} u ${v.vrijeme} je otkazan. Kad god poželite, novi termin možete rezervirati ovdje:`,
      { button: 'Rezervirajte novi termin', href: v.link_rezervacija },
      'Barbara',
    ],
  }),
  otkazan_admin: (v, extra) => ({
    subject: `Otkazano: ${v.usluga} – ${v.datum} u ${v.vrijeme}`,
    lines: [
      `${v.punoIme} je otkazala termin putem linka iz emaila.`,
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme}`, `${v.telefon} · ${v.email}`] },
      'Termin je ponovno slobodan za rezervacije.',
      `<a href="${extra.adminUrl}">Otvori administraciju</a>`,
    ],
  }),
  hvala: (v, extra) => ({
    subject: 'Hvala što ste bili kod mene 🤍',
    lines: [
      `Bok ${v.ime},`,
      'hvala vam na povjerenju! Nadam se da ste zadovoljni svojim lookom.',
      `Ako želite, ostavite mi kratku recenziju ili me označite na Instagramu (${extra.instagram}) – to mi puno znači.`,
      extra.reviewUrl ? { button: 'Ostavite recenziju', href: extra.reviewUrl } : { button: 'Instagram', href: extra.instagramUrl },
      'Barbara',
    ],
  }),
};

function renderHtml({ subject, lines }, business) {
  const base = baseUrl();
  const body = lines.map((l) => {
    if (typeof l === 'string') return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#2B2421">${l}</p>`;
    if (l.box) return `<table role="presentation" width="100%" style="margin:4px 0 20px;border-top:1px solid #DDD2C8;border-bottom:1px solid #DDD2C8"><tr><td style="padding:14px 0">${l.box.map((x, i) => `<div style="font-family:Lora,Georgia,serif;font-size:${i === 0 ? 19 : 15}px;line-height:1.6;color:${i === 0 ? '#2B2421' : '#6B5D56'}">${escHtml(x)}</div>`).join('')}</td></tr></table>`;
    if (l.button) return `<p style="margin:0 0 16px"><a href="${l.href}" style="display:inline-block;padding:12px 26px;border-radius:999px;font-size:13px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;${l.secondary ? 'border:1px solid #2B2421;color:#2B2421' : 'background:#2B2421;color:#F3EDE7'}">${escHtml(l.button)}</a></p>`;
    return '';
  }).join('');
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F3EDE7;font-family:Poppins,'Helvetica Neue',Arial,sans-serif">
<table role="presentation" width="100%" style="background:#F3EDE7"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#FFFFFF">
<tr><td align="center" style="padding:32px 32px 8px"><img src="${base}/assets/logo/email_logo.png" width="240" alt="Barbara Skoko Beauty" style="display:block;width:240px;max-width:80%;height:auto"></td></tr>
<tr><td style="padding:24px 32px 8px">${body}</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #DDD2C8;font-size:12px;line-height:1.7;color:#6B5D56;text-align:center">
Barbara Skoko Beauty · Makeup · Threading · ${escHtml(business.city)}<br>${escHtml(business.phone)} · ${escHtml(business.instagram)}
</td></tr></table></td></tr></table></body></html>`;
}

function renderText({ lines }, business) {
  const t = lines.map((l) => {
    if (typeof l === 'string') return l.replace(/<br>/g, '\n').replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1').replace(/<[^>]+>/g, '');
    if (l.box) return l.box.join('\n');
    if (l.button) return `${l.button}: ${l.href}`;
    return '';
  }).join('\n\n');
  return `${t}\n\n—\nBarbara Skoko Beauty · Makeup · Threading · ${business.city}\n${business.phone} · ${business.instagram}`;
}

export function buildCustom(subject, lines, business) {
  const tpl = { subject, lines };
  return { subject, html: renderHtml(tpl, business), text: renderText(tpl, business) };
}

export function buildEmail(kind, booking, business, extra = {}) {
  const tpl = TEMPLATES[kind](vars(booking, business), {
    phone: business.phone,
    instagram: business.instagram,
    instagramUrl: business.instagramUrl,
    reviewUrl: business.reviewUrl,
    kada: 'sutra',
    adminUrl: `${baseUrl()}/admin`,
    confirmUrl: actionLink(booking.id, 'potvrdi'),
    declineUrl: actionLink(booking.id, 'odbij'),
    ...extra,
  });
  return { subject: tpl.subject, html: renderHtml(tpl, business), text: renderText(tpl, business) };
}

export async function sendRaw({ to, subject, html, text, attachments, kind = 'ostalo', bookingId = null, replyTo }) {
  const t = getTransport();
  if (!t) {
    console.log(`[email nije poslan – SMTP nije podešen] ${kind} → ${to}: ${subject}`);
    await q('INSERT INTO email_log (booking_id, kind, to_addr, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, kind, to, subject, 'nije_poslano', 'SMTP nije podešen (SMTP_USER / SMTP_PASS)']);
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || `Barbara Skoko Beauty <${process.env.SMTP_USER}>`,
      to, subject, html, text, attachments, replyTo,
    });
    await q('INSERT INTO email_log (booking_id, kind, to_addr, subject, status) VALUES ($1,$2,$3,$4,$5)', [bookingId, kind, to, subject, 'poslano']);
    return true;
  } catch (err) {
    console.error('[email greška]', err.message);
    await q('INSERT INTO email_log (booking_id, kind, to_addr, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, kind, to, subject, 'greska', err.message.slice(0, 500)]);
    return false;
  }
}

/** Pošalji predložak vezan uz rezervaciju. toAdmin = šalje se Barbari. */
export async function sendBookingEmail(kind, booking, business, { toAdmin = false, to, extra } = {}) {
  const recipient = to || (toAdmin ? adminEmail(business) : booking.email);
  if (!recipient) return false;
  const mail = buildEmail(kind, booking, business, extra);
  const attachments = ['potvrden', 'promijenjen'].includes(kind)
    ? [{ filename: 'termin.ics', content: bookingIcs(booking, business, baseUrl()), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }]
    : undefined;
  return sendRaw({
    to: recipient, ...mail, attachments, kind, bookingId: booking.id,
    replyTo: toAdmin ? booking.email || undefined : business.email,
  });
}
