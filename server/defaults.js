// Početni podaci iz paketa (03_Podaci). Sve se kasnije mijenja u administraciji.

export const DEFAULT_SERVICES = [
  { id: 'sminkanje', category: 'MAKEUP', name: 'Šminkanje', description: 'Dnevni, večernji i svečani look.', price: 60, duration: 60, slot_step: 60 },
  { id: 'henna', category: 'BROWS', name: 'Henna', description: 'Oblikovanje i bojanje obrva kanom.', price: 25, duration: 30, slot_step: 30 },
  { id: 'classic', category: 'BROWS', name: 'Classic', description: 'Klasično oblikovanje i bojanje obrva.', price: 20, duration: 30, slot_step: 30 },
  { id: 'threading', category: 'BROWS', name: 'Threading', description: 'Precizno oblikovanje obrva koncem.', price: 15, duration: 30, slot_step: 30 },
  { id: 'nadusnice', category: 'FACE', name: 'Nadusnice', description: 'Uklanjanje dlačica iznad usne koncem.', price: 5, duration: 30, slot_step: 30 },
];

// Barbara radi 08:30–12:30 i 16:30–20:30 (pauza dok je dijete iz vrtića doma)
const day = { open: '08:30', close: '20:30', breakFrom: '12:30', breakTo: '16:30' };

export const DEFAULT_SETTINGS = {
  business: {
    name: 'Barbara Skoko Beauty',
    owner: 'Barbara Skoko',
    address: 'Ivana Zajca II-2',
    // Što se traži na Google karti (naziv mjesta ili koordinate "43.38, 17.59")
    mapQuery: '43.3751761, 17.6075204', // Elbas Apartman, ista kuća
    city: 'Široki Brijeg',
    phone: '+387 63 674 074',
    whatsapp: 'https://wa.me/38763674074',
    email: 'barbaraskokobeauty@gmail.com',
    instagram: '@barbaraskokobeauty',
    instagramUrl: 'https://www.instagram.com/barbaraskokobeauty/',
    reviewUrl: '',
  },
  // 0 = nedjelja, 1 = ponedjeljak … 6 = subota; null = zatvoreno
  hours: { 0: null, 1: day, 2: day, 3: day, 4: day, 5: day, 6: day },
  rules: {
    minNoticeHours: 2,
    maxDaysAhead: 60,
    cancelHours: 24,
    autoConfirm: false,
    allowMultiple: true,
    bufferMin: 0,
  },
  notify: {
    reminders: true,
    thanks: true,
    dailySummary: true,
  },
  // Dodatne mogućnosti – Barbara ih uključuje u Postavkama
  features: {
    push: true, // obavijesti na mobitel
    backup: true, // tjedna sigurnosna kopija na email
    waitlist: true, // lista čekanja
    calendarFeed: false, // termini u kalendaru mobitela
    holidays: false, // praznici se sami blokiraju
    rebook: false, // podsjetnik „vrijeme je za obrve”
    events: false, // upiti za vjenčanja i svečanosti
    vouchers: false, // poklon bonovi
    reviews: false, // recenzije na stranici
    priceList: false, // posebna sekcija s cjenikom (cijene se vide i u rezervaciji)
  },
  extras: {
    holidays: null, // null = svi s popisa (server/holidays.js)
    rebookDays: { BROWS: 35, FACE: 35, MAKEUP: 0 }, // 0 = bez podsjetnika
    depositInfo: '',
    voucherAmounts: [30, 50, 100],
    voucherPayment: 'Bon plaćate u salonu, a Barbara vam ga zatim šalje emailom.',
    voucherMonths: 12,
  },
  meta: {},
};
