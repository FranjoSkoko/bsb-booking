// Brojevi se upisuju na razne načine (063 …, +387 63 …, 00387 63 …).
// Za tel: i wa.me linkove treba isti međunarodni oblik bez "+".
// Isto pravilo ima i public/admin/admin.js (phoneDigits).

export function phoneDigits(phone, country = '387') {
  const raw = String(phone || '').trim();
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return country + d.slice(1);
  if (d.length <= 9) return country + d; // npr. "63 900 107"
  return d;
}

export const telHref = (phone) => (phoneDigits(phone) ? `tel:+${phoneDigits(phone)}` : '');
export const waHref = (phone) => (phoneDigits(phone) ? `https://wa.me/${phoneDigits(phone)}` : '');
