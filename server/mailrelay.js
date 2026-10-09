// Slanje emailova preko Google Apps Script web-aplikacije (gmail-skripta.gs).
// Railway na besplatnom i Hobby planu blokira SMTP, a ovo ide preko HTTPS-a,
// pa mailovi i dalje odlaze s Barbarinog Gmaila.

export const relayConfigured = () => Boolean(process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_KEY);

// Skripta od verzije 2 umeće slike u sam mail (inlineImages). Dok se ne javi takva verzija,
// logo ide kao poveznica na stranicu, da starija skripta ne pošalje mail bez loga.
let relayVersion = 0;
export const relaySupportsInline = () => relayVersion >= 2;

const toBase64 = (content) => Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(String(content), 'utf8').toString('base64');

/** Pošalji jedan mail preko skripte. Baca grešku ako skripta ne potvrdi slanje. */
export async function sendViaRelay({ to, subject, html, text, attachments, inlineImages, replyTo, from, name }, {
  url = process.env.MAIL_RELAY_URL, key = process.env.MAIL_RELAY_KEY, timeoutMs = 30000,
} = {}) {
  const body = {
    key, to, subject, html, text, replyTo, from, name,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename,
      // Apps Script ne voli parametre u tipu (npr. "; charset=utf-8")
      contentType: String(a.contentType || 'application/octet-stream').split(';')[0].trim(),
      content: toBase64(a.content),
    })),
    inlineImages: (inlineImages || []).map((i) => ({ cid: i.cid, filename: i.filename, contentType: i.contentType, content: toBase64(i.content) })),
  };
  // Apps Script odgovara preusmjeravanjem (302) na stranicu s rezultatom; fetch ga sam prati.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err) => {
    throw new Error(`Skripta nedostupna: ${err.cause?.message || err.message}`);
  });
  const raw = await res.text();
  let out;
  try { out = JSON.parse(raw); } catch {
    throw new Error(`Skripta nije vratila odgovor (HTTP ${res.status}). Je li implementirana kao web-aplikacija s pristupom "Svi"?`);
  }
  if (!out.ok) throw new Error(`Skripta: ${out.error || 'nepoznata greška'}`);
  relayVersion = Number(out.verzija) || 1;
  return out;
}
