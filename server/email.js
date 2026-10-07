import nodemailer from 'nodemailer';
import { relayConfigured, sendViaRelay } from './mailrelay.js';
import { q } from './db.js';
import { formatDateHr, toHHMM } from './time.js';
import { bookingIcs } from './ics.js';
import { actionLink } from './auth.js';
import { baseUrl } from './config.js';
import { telHref, waHref } from './phone.js';

export { baseUrl };

let transport = null;
const smtpConfigured = () => Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
export function emailConfigured() {
  return relayConfigured() || smtpConfigured();
}
function getTransport() {
  if (!smtpConfigured()) return null;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      // Kad je SMTP blokiran (npr. Railway bez Pro plana), ne čekaj zadane 2 minute.
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
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
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

const clean = (s) => String(s ?? '').replace(/[<>]/g, '');
const href = (s) => String(s ?? '').replace(/["<>\s]/g, (c) => encodeURIComponent(c));
const a = (url, label, style = '') => `<a href="${href(url)}"${style ? ` style="${style}"` : ''}>${escHtml(label)}</a>`;

// "+387 63 674 074 ili WhatsApp" – oba se mogu dodirnuti
function contactHtml(business) {
  const wa = business.whatsapp || waHref(business.phone);
  return `${a(telHref(business.phone), business.phone)}${wa ? ` ili ${a(wa, 'WhatsApp')}` : ''}`;
}

// Pravilo otkazivanja ispod gumba za detalje (cancelHours/canCancel dolaze iz clientMailExtra)
function cancelRule(extra) {
  if (extra.cancelHours == null) return null;
  if (extra.canCancel === false) return `Za otkazivanje ili promjenu termina javite mi se na ${extra.kontakt}.`;
  const doKada = extra.cancelHours > 0 ? `najkasnije ${extra.cancelHours} h prije termina` : 'sve do početka termina';
  return `Termin možete sami otkazati putem tog linka ${doKada}. Nakon toga mi se javite na ${extra.kontakt}.`;
}
const detailsButton = (v, extra) => ({ button: extra.canCancel === false ? 'Detalji termina' : 'Detalji ili otkazivanje', href: v.link_otkazivanje });

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
    // Ista usluga je već odabrana kad klijentica otvori link
    link_rezervacija: `${base}/rezerviraj${b.services[0]?.id ? `?usluga=${encodeURIComponent(b.services[0].id)}` : ''}`,
    tel_klijentice: telHref(b.phone),
    wa_klijentice: waHref(b.phone),
  };
}

// Svaki predložak vraća { subject, lines } – lines: tekst ili {button, href} ili {box: [...]}
const TEMPLATES = {
  zaprimljen: (v, extra) => ({
    subject: 'Zaprimili smo vaš zahtjev za termin 🤍',
    lines: [
      `Bok ${v.ime},`,
      'hvala vam na rezervaciji! Vaš zahtjev za termin je zaprimljen:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme} (${v.trajanje} min)`, `${v.cijena} KM`] },
      'Termin ću potvrditi u najkraćem mogućem roku – javit ću vam se emailom.',
      { button: 'Pogledajte svoju rezervaciju', href: v.link_otkazivanje },
      cancelRule(extra),
      'Do skorog viđenja,<br>Barbara',
    ],
  }),
  // autoConfirmed: termin je već potvrđen, pa Barbari ne trebaju gumbi Potvrdi/Odbij
  novi_zahtjev: (v, extra) => ({
    subject: `${extra.autoConfirmed ? 'Nova rezervacija (potvrđena)' : 'Novi zahtjev'}: ${v.usluga} – ${v.datum} u ${v.vrijeme}`,
    lines: [
      extra.autoConfirmed ? 'Termin je automatski potvrđen i klijentica je dobila potvrdu.' : null,
      { box: [`${v.usluga} · ${v.cijena} KM`, `${v.datum} u ${v.vrijeme} (${v.trajanje} min)`, `${v.punoIme} · ${v.telefon} · ${v.email}`, `Napomena: ${v.napomena}`] },
      v.tel_klijentice ? `${a(v.tel_klijentice, 'Nazovi klijenticu')} · ${a(v.wa_klijentice, 'WhatsApp')}` : null,
      ...(extra.autoConfirmed ? [] : [
        { button: 'Potvrdi', href: extra.confirmUrl },
        { button: 'Odbij', href: extra.declineUrl, secondary: true },
      ]),
      a(extra.adminUrl, 'Otvori administraciju'),
    ],
  }),
  potvrden: (v, extra) => ({
    subject: 'Vaš termin je potvrđen ✨',
    lines: [
      `Bok ${v.ime},`,
      'vaš termin je potvrđen:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme}`, `📍 ${v.lokacija}`] },
      `<a href="${v.link_karta}">Upute do salona (Google karte)</a>`,
      'Mali savjet: na termin dođite čistog lica, a večer prije nanesite hidratantnu kremu.',
      'Termin možete dodati u svoj kalendar pomoću priložene datoteke.',
      detailsButton(v, extra),
      cancelRule(extra),
      'Veselim se!<br>Barbara',
    ],
  }),
  promijenjen: (v, extra) => ({
    subject: 'Vaš termin je promijenjen',
    lines: [
      `Bok ${v.ime},`,
      'kako smo se dogovorile, vaš termin je pomaknut. Novi termin:',
      { box: [`${v.usluga}`, `${v.datum} u ${v.vrijeme}`, `📍 ${v.lokacija}`] },
      `<a href="${v.link_karta}">Upute do salona (Google karte)</a>`,
      'U privitku je ažurirani termin za vaš kalendar.',
      detailsButton(v, extra),
      cancelRule(extra),
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
      `Ako se nešto promijenilo, javite mi na ${extra.kontakt}.`,
      'Barbara',
    ],
  }),
  odbijen: (v, extra) => ({
    subject: 'Termin nije moguć – odaberite drugo vrijeme',
    lines: [
      `Bok ${v.ime},`,
      `nažalost, termin ${v.datum} u ${v.vrijeme} ne mogu potvrditi. Odaberite drugi slobodan termin ili mi se javite na ${extra.kontakt}.`,
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
      a(extra.adminUrl, 'Otvori administraciju'),
    ],
  }),
  hvala: (v, extra) => ({
    subject: 'Hvala što ste bili kod mene 🤍',
    lines: extra.ownReviewUrl ? [
      `Bok ${v.ime},`,
      'hvala vam na povjerenju! Nadam se da ste zadovoljni svojim lookom.',
      'Ako imate minutu, ocijenite termin – vaš dojam pomaže drugim klijenticama, a meni puno znači.',
      { button: 'Ocijenite termin', href: extra.ownReviewUrl },
      `Slobodno me označite i na Instagramu (${a(extra.instagramUrl, extra.instagram)}).`,
      'Barbara',
    ] : [
      `Bok ${v.ime},`,
      'hvala vam na povjerenju! Nadam se da ste zadovoljni svojim lookom.',
      extra.reviewUrl
        ? `Ako želite, ostavite mi kratku recenziju ili me označite na Instagramu (${a(extra.instagramUrl, extra.instagram)}) – to mi puno znači.`
        : `Ako želite, označite me na Instagramu (${a(extra.instagramUrl, extra.instagram)}) – to mi puno znači.`,
      extra.reviewUrl ? { button: 'Ostavite recenziju', href: extra.reviewUrl } : { button: 'Instagram', href: extra.instagramUrl },
      'Barbara',
    ],
  }),
};

function renderHtml({ subject, lines }, business) {
  const base = baseUrl();
  const muted = 'color:#6B5D56';
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
Barbara Skoko Beauty · Makeup · Threading · ${escHtml(business.city)}<br>${a(telHref(business.phone), business.phone, muted)} · ${a(business.instagramUrl, business.instagram, muted)}
</td></tr></table></td></tr></table></body></html>`;
}

function renderText({ lines }, business) {
  const t = lines.map((l) => {
    if (typeof l === 'string') {
      return l.replace(/<br>/g, '\n')
        .replace(/<a href="tel:[^"]+">([^<]+)<\/a>/g, '$1') // broj je već u tekstu
        .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&');
    }
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
    kontakt: contactHtml(business),
    instagram: business.instagram,
    instagramUrl: business.instagramUrl,
    reviewUrl: business.reviewUrl,
    kada: 'sutra',
    adminUrl: `${baseUrl()}/admin`,
    confirmUrl: actionLink(booking.id, 'potvrdi'),
    declineUrl: actionLink(booking.id, 'odbij'),
    ...extra,
  });
  tpl.lines = tpl.lines.filter(Boolean);
  return { subject: tpl.subject, html: renderHtml(tpl, business), text: renderText(tpl, business) };
}

export const icsAttachment = (booking, business) => ({
  filename: 'termin.ics', content: bookingIcs(booking, business, baseUrl()), contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
});

export async function sendRaw({ to, subject, html, text, attachments, kind = 'ostalo', bookingId = null, replyTo }) {
  const relay = relayConfigured();
  const t = relay ? null : getTransport();
  if (!relay && !t) {
    console.log(`[email nije poslan – slanje nije podešeno] ${kind} → ${to}: ${subject}`);
    await q('INSERT INTO email_log (booking_id, kind, to_addr, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, kind, to, subject, 'nije_poslano', 'Slanje nije podešeno (MAIL_RELAY_URL / MAIL_RELAY_KEY ili SMTP_USER / SMTP_PASS)']);
    return false;
  }
  try {
    if (relay) {
      await sendViaRelay({ to, subject, html, text, attachments, replyTo, name: 'Barbara Skoko Beauty' });
    } else {
      await t.sendMail({
        from: process.env.MAIL_FROM || `Barbara Skoko Beauty <${process.env.SMTP_USER}>`,
        to, subject, html, text, attachments, replyTo,
      });
    }
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
  const attachments = ['potvrden', 'promijenjen'].includes(kind) ? [icsAttachment(booking, business)] : undefined;
  return sendRaw({
    to: recipient, ...mail, attachments, kind, bookingId: booking.id,
    replyTo: toAdmin ? booking.email || undefined : business.email,
  });
}
