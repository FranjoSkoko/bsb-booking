export function baseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const replit = (process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN || '').split(',')[0];
  if (replit) return `https://${replit}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}
