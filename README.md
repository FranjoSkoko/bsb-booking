# Barbara Skoko Beauty – online rezervacije

Web aplikacija za rezervaciju termina (makeup i obrve, Široki Brijeg). Klijentica u 3 koraka odabere uslugu, datum i vrijeme i upiše svoje podatke, a Barbara u administraciji potvrđuje termine. Sve je na hrvatskom i u stilu brenda.

## Što aplikacija radi

**Za klijentice**
- Stranica s cjenikom, O meni, radovima (galerija), savjetima za pripremu i kontaktom s kartom.
- Rezervacija u 3 koraka: usluga (može i više usluga zaredom, s ukupnom cijenom i trajanjem) → datum i slobodan termin → podaci i privola.
- Termini: šminkanje na puni sat (60 min), obrve i lice svakih 30 min, pon–sub 09:00–19:00, najranije 2 h i najkasnije 60 dana unaprijed. Nema dvostrukih rezervacija.
- Nakon slanja: potvrda u aplikaciji, email, stranica „Moja rezervacija” (status, dodavanje u kalendar, otkazivanje do 24 h prije).
- Aplikacija se može instalirati na mobitel (PWA) i pamti podatke klijentice za sljedeću rezervaciju.

**Za Barbaru (`/admin`)**
- Danas i sutra na prvom mjestu, zahtjevi na čekanju s gumbima Potvrdi / Odbij.
- Kalendar (tjedan i mjesec), ručni upis termina (telefonom dogovoreni), pomicanje termina, „nije došla”.
- Blokiranje dana ili sati (godišnji, privatne obaveze).
- Karton klijentica: povijest posjeta, bilješke, brisanje podataka na zahtjev.
- Postavke: usluge i cijene, radno vrijeme, pravila, adresa, galerija, probni emailovi i popis poslanih emailova.
- Link za Instagram bio: `/rezerviraj` (ili `/rezerviraj?usluga=sminkanje`).

**Emailovi (automatski)**
1. Zahtjev zaprimljen → klijentici
2. Novi zahtjev → Barbari, s gumbima Potvrdi / Odbij (jedan dodir s mobitela)
3. Termin potvrđen → klijentici (s datotekom za kalendar)
4. Podsjetnik 24 h prije → klijentici
5. Termin odbijen → klijentici
6. Termin otkazan → klijentici (i Barbari kad otkaže klijentica)
7. Hvala + recenzija → klijentici dan nakon termina
8. Termin promijenjen → klijentici (kad ga Barbara pomakne)
Uz to Barbara svako jutro u 7:00 dobiva pregled dana.

## Pokretanje na Replitu

1. Na replit.com: **Create App → Import from GitHub** i odaberite repozitorij `bsb-booking`.
2. U Replitu otvorite **Database** i dodajte **PostgreSQL** bazu (Replit sam postavi `DATABASE_URL`).
3. U **Tools → Secrets** dodajte:

   | Ime | Vrijednost |
   |---|---|
   | `ADMIN_PASSWORD` | lozinka za administraciju |
   | `SESSION_SECRET` | dugi nasumični niz znakova (npr. 40 slova i brojeva) |
   | `SMTP_USER` | `barbaraskokobeauty@gmail.com` |
   | `SMTP_PASS` | Gmail **App password** (vidi niže) |
   | `PUBLIC_URL` | adresa objavljene aplikacije, npr. `https://bsb-booking.replit.app` (dodajte nakon prve objave) |

4. Kliknite **Run** i otvorite `/admin` za prijavu.
5. Za stalni rad: **Deploy → Reserved VM** (aplikacija mora stalno raditi da bi slala podsjetnike). Nakon objave upišite adresu u `PUBLIC_URL` i ponovno objavite.

### Gmail App password
Gmail ne dopušta slanje s običnom lozinkom. Na računu barbaraskokobeauty@gmail.com:
1. Uključite **dvostruku provjeru** (Google račun → Sigurnost → Potvrda u dva koraka).
2. Otvorite <https://myaccount.google.com/apppasswords>, napravite lozinku s imenom „BSB rezervacije”.
3. Dobivenih 16 znakova (bez razmaka) upišite kao `SMTP_PASS`.

Nakon toga u administraciji (Postavke → Email) kliknite **Pošalji probne emailove**.

### Ako koristite Autoscale umjesto Reserved VM
Autoscale „spava” kad nema posjeta pa podsjetnici kasne. Tada dodajte tajnu `CRON_SECRET` i na besplatnom servisu (npr. cron-job.org) svakih 10 minuta pozivajte `https://VAŠA-ADRESA/api/cron?key=CRON_SECRET`.

## Prije objave provjeriti
- Adresa salona je upisana (Ivana Zajca II-2, Široki Brijeg), a karta traži „Elbas Apartman” u istoj kući. Ako pribadača nije točno na kući, u Postavkama upišite koordinate iz Google karata u polje „Lokacija na karti”.
- Radi li Barbara nedjeljom (zadano: ne).
- Kratki opisi usluga Henna, Classic i Nadusnice (upisani su prijedlozi).
- Rok otkazivanja 24 h, najranije 2 h i najkasnije 60 dana unaprijed.
- Smiju li klijentice odabrati više usluga zaredom (zadano: da).
- Fotografija za „O meni” i radovi za galeriju (Postavke → Fotografije).

## Lokalni razvoj

```bash
npm install
cp .env.example .env   # pa popunite i učitajte varijable
npm start              # http://localhost:3000
npm test
```

Tehnologija: Node.js (Express), PostgreSQL, Nodemailer; sučelje je obični HTML/CSS/JS bez build koraka.
