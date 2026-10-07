export function baseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    || (process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN || '').split(',')[0];
  if (host) return `https://${host}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

export const isHttps = () => baseUrl().startsWith('https://');
