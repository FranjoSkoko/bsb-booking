// Barbara Skoko Beauty – slanje mailova s ovog Gmail računa.
// Zalijepite u novi projekt na script.google.com (prijavljeni kao barbaraskokobeauty@gmail.com).
// KLJUC mora biti isti kao varijabla MAIL_RELAY_KEY na Railwayu.
const KLJUC = 'OVDJE_ZALIJEPITE_KLJUC';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== KLJUC) return odgovor({ ok: false, error: 'Pogrešan ključ' });
    const opcije = { htmlBody: d.html, name: d.name || 'Barbara Skoko Beauty' };
    if (d.replyTo) opcije.replyTo = d.replyTo;
    if (d.attachments && d.attachments.length) {
      opcije.attachments = d.attachments.map(function (a) {
        return Utilities.newBlob(Utilities.base64Decode(a.content), a.contentType, a.filename);
      });
    }
    // Adresa na domeni (npr. info@...) radi samo ako je u Gmailu dodana pod „Pošalji poštu kao”
    if (d.from && GmailApp.getAliases().map(function (a) { return a.toLowerCase(); }).indexOf(String(d.from).toLowerCase()) !== -1) {
      opcije.from = d.from;
      GmailApp.sendEmail(d.to, d.subject, d.text || '', opcije);
    } else {
      MailApp.sendEmail(d.to, d.subject, d.text || '', opcije);
    }
    return odgovor({ ok: true, preostaloDanas: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return odgovor({ ok: false, error: String(err) });
  }
}

function odgovor(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Pokrenite jednom ručno (gumb Pokreni) da Google zatraži dopuštenje za slanje.
function proba() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'BSB: skripta za mailove radi', 'Ova poruka znači da je skripta spremna.');
}
