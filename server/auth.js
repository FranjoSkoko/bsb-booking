import crypto from 'node:crypto';
import { baseUrl } from './config.js';

function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) return 'bsb-dev-secret';
  return s;
}

const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const randomToken = () => crypto.randomBytes(18).toString('base64url');

// ---------- prijava u administraciju ----------

const COOKIE = 'bsb_admin';
const SESSION_DAYS = 30;

export function checkPassword(pw) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return safeEqual(hmac('pw:' + pw), hmac('pw:' + expected));
}

export function sessionCookie(res) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const value = `${exp}.${hmac('admin:' + exp)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || Boolean(process.env.REPLIT_DOMAINS),
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isAdmin(req) {
  const c = readCookie(req, COOKIE);
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac('admin:' + exp));
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Prijavite se ponovno.' });
}

// ---------- potpisani linkovi iz emaila (Potvrdi / Odbij jednim dodirom) ----------

export function actionSig(bookingId, action) {
  return hmac(`action:${bookingId}:${action}`).slice(0, 24);
}

export function verifyAction(bookingId, action, sig) {
  return safeEqual(actionSig(bookingId, action), sig || '');
}

export function actionLink(bookingId, action) {
  return `${baseUrl()}/admin/akcija?b=${bookingId}&a=${action}&s=${actionSig(bookingId, action)}`;
}
