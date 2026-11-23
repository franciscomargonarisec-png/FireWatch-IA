// Cuentas de usuario: registro, login con email y contraseña, login con Google y sesiones.
// Usa PostgreSQL cuando DATABASE_URL está configurada (ideal para Render); fallback a data/*.json en local.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pool, hasPg } from './db.js';

const scrypt = promisify(crypto.scrypt);
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const USERS_FILE = path.join(DIR, 'users.json');
const SESSIONS_FILE = path.join(DIR, 'sessions.json');
const SESSION_DAYS = 7;
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FORCE_SECURE = process.env.COOKIE_SECURE === '1';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ───────── Almacenamiento en archivos JSON (solo si no hay DATABASE_URL) ───────── */
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const write = (f, obj) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(f + '.tmp', f);
};
const localUsers = read(USERS_FILE, []);
const localSessions = read(SESSIONS_FILE, {});
for (const k of Object.keys(localSessions)) if (localSessions[k].exp < Date.now()) delete localSessions[k];
const saveLocalUsers = () => write(USERS_FILE, localUsers);
const saveLocalSessions = () => write(SESSIONS_FILE, localSessions);

const mapRowToUser = (r) => r && ({
  id: r.id,
  name: r.name,
  email: r.email,
  password: r.password || null,
  googleSub: r.google_sub ?? r.googleSub ?? null,
  picture: r.picture || null,
  createdAt: r.created_at ?? r.createdAt ?? null,
});

async function findUserByEmail(email) {
  if (!hasPg()) return localUsers.find((u) => u.email === email) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  return mapRowToUser(rows[0]);
}

async function findUserByGoogleSub(sub) {
  if (!hasPg()) return localUsers.find((u) => u.googleSub === sub) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE google_sub = $1 LIMIT 1', [sub]);
  return mapRowToUser(rows[0]);
}

async function findUserById(id) {
  if (!hasPg()) return localUsers.find((u) => u.id === id) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return mapRowToUser(rows[0]);
}

async function createUser(u) {
  if (!hasPg()) {
    localUsers.push(u);
    saveLocalUsers();
    return u;
  }
  await pool.query(
    `INSERT INTO users (id, name, email, password, google_sub, picture)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [u.id, u.name, u.email, u.password || null, u.googleSub || null, u.picture || null]
  );
  return u;
}

async function linkGoogleUser(user, sub, picture) {
  const nextSub = user.googleSub || sub;
  const nextPic = picture || user.picture || null;
  if (!hasPg()) {
    user.googleSub = nextSub;
    user.picture = nextPic;
    saveLocalUsers();
    return user;
  }
  await pool.query(
    'UPDATE users SET google_sub = $1, picture = $2 WHERE id = $3',
    [nextSub, nextPic, user.id]
  );
  return { ...user, googleSub: nextSub, picture: nextPic };
}

async function persistSession(tokenHash, uid, exp) {
  if (!hasPg()) {
    localSessions[tokenHash] = { uid, exp };
    saveLocalSessions();
    return;
  }
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
    [tokenHash, uid, exp]
  );
}

async function readSession(tokenHash) {
  if (!hasPg()) return localSessions[tokenHash] || null;
  const { rows } = await pool.query(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 LIMIT 1',
    [tokenHash]
  );
  if (!rows[0]) return null;
  return { uid: rows[0].user_id, exp: Number(rows[0].expires_at) };
}

async function deleteSession(tokenHash) {
  if (!hasPg()) {
    delete localSessions[tokenHash];
    saveLocalSessions();
    return;
  }
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export async function logActivity(userEmail, actionType, summary) {
  if (!hasPg()) return;
  try {
    await pool.query(
      'INSERT INTO activity_logs (user_email, action_type, summary) VALUES ($1, $2, $3)',
      [userEmail || null, actionType, String(summary).slice(0, 500)]
    );
  } catch (e) {
    console.log('[DB logActivity]', e.message);
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = (u) => ({ name: u.name, email: u.email, picture: u.picture || null });

/* ───────── Contraseñas (scrypt con sal propia) ───────── */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = await scrypt(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ───────── Sesiones (cookie HttpOnly con un token al azar) ───────── */
const parseCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((a) => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );

export async function currentUser(req) {
  const token = parseCookies(req).fw_session;
  if (!token) return null;
  const h = sha(token);
  const s = await readSession(h);
  if (!s || s.exp < Date.now()) {
    if (s) await deleteSession(h);
    return null;
  }
  return await findUserById(s.uid);
}

async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await persistSession(sha(token), user.id, Date.now() + SESSION_DAYS * 864e5);
  const secure = FORCE_SECURE || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `fw_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

/* ───────── Utilidades ───────── */
export function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 20000) throw new Error('Mensaje demasiado largo.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Datos inválidos.'); }
}

const attempts = new Map();
const WINDOW = 10 * 60 * 1000;
const tooMany = (key, max = 8) => (attempts.set(key, (attempts.get(key) || []).filter((t) => Date.now() - t < WINDOW)), attempts.get(key).length >= max);
const addAttempt = (key) => attempts.get(key)?.push(Date.now()) ?? attempts.set(key, [Date.now()]);

/* ───────── Google: se verifica el token firmado por Google ───────── */
let jwks = { keys: [], at: 0 };
async function googleKeys() {
  if (jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('no se pudo contactar a Google');
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}

export async function verifyGoogleToken(credential) {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new Error('Token de Google inválido.');
  const [h, p, s] = parts;
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, 'base64url')); claims = JSON.parse(Buffer.from(p, 'base64url')); } catch { throw new Error('Token de Google inválido.'); }
  if (header.alg !== 'RS256') throw new Error('Token de Google inválido.');
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Token de Google inválido.');
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!valid) throw new Error('Token de Google inválido.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Token de Google inválido.');
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('Este token no es para esta aplicación.');
  if (!(claims.exp * 1000 > Date.now())) throw new Error('El token de Google venció. Probá de nuevo.');
  if (!(claims.email_verified === true || claims.email_verified === 'true') || !claims.email) throw new Error('Tu email de Google no está verificado.');
  return claims;
}

/* ───────── Rutas: /api/config, /api/me, /api/auth/* ───────── */
export async function handleAuth(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith('/api/auth/') && p !== '/api/me' && p !== '/api/config') return false;
  try {
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null }), true;
    if (req.method === 'GET' && p === '/api/me') {
      const u = await currentUser(req);
      return (u ? json(res, 200, { user: publicUser(u) }) : json(res, 401, { error: 'No hay sesión.' })), true;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' }), true;
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origen no permitido.' }), true;

    const ip = req.socket.remoteAddress;
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');

    if (p === '/api/auth/logout') {
      const t = parseCookies(req).fw_session;
      if (t) await deleteSession(sha(t));
      res.setHeader('Set-Cookie', 'fw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true }), true;
    }

    if (p === '/api/auth/register') {
      if (tooMany('reg|' + ip, 10)) throw new Error('Demasiados intentos. Esperá unos minutos.');
      addAttempt('reg|' + ip);
      const name = String(b.name || '').trim();
      if (name.length < 2 || name.length > 60) throw new Error('Escribí tu nombre (entre 2 y 60 caracteres).');
      if (!EMAIL.test(email) || email.length > 120) throw new Error('El email no es válido.');
      if (password.length < 8 || password.length > 100) throw new Error('La contraseña debe tener entre 8 y 100 caracteres.');
      const existing = await findUserByEmail(email);
      if (existing) throw new Error(existing.password ? 'Ese email ya está registrado. Probá ingresar.' : 'Ese email ya está registrado con Google. Ingresá con Google.');
      const user = await createUser({ id: crypto.randomUUID(), name, email, password: await hashPassword(password), createdAt: new Date().toISOString() });
      await startSession(req, res, user);
      await logActivity(user.email, 'register', `Nuevo usuario registrado: ${user.email}`);
      return json(res, 200, { user: publicUser(user) }), true;
    }

    if (p === '/api/auth/login') {
      const key = `login|${ip}|${email}`;
      if (tooMany(key)) throw new Error('Demasiados intentos. Esperá unos minutos.');
      const user = await findUserByEmail(email);
      if (user && !user.password) { addAttempt(key); throw new Error('Esa cuenta usa Google. Tocá "Continuar con Google".'); }
      if (!user || !(await checkPassword(password, user.password))) { addAttempt(key); throw new Error('Email o contraseña incorrectos.'); }
      attempts.delete(key);
      await startSession(req, res, user);
      await logActivity(user.email, 'login', `Inicio de sesión: ${user.email}`);
      return json(res, 200, { user: publicUser(user) }), true;
    }

    if (p === '/api/auth/google') {
      if (!GOOGLE_CLIENT_ID) throw new Error('Google no está configurado en el servidor (falta GOOGLE_CLIENT_ID).');
      if (tooMany('goog|' + ip, 20)) throw new Error('Demasiados intentos. Esperá unos minutos.');
      addAttempt('goog|' + ip);
      let claims;
      try { claims = await verifyGoogleToken(b.credential); }
      catch (e) { throw new Error(/Token|token|Google|email/.test(e.message) ? e.message : 'No se pudo verificar con Google.'); }
      const gmail = claims.email.toLowerCase();
      let user = await findUserByGoogleSub(claims.sub) || await findUserByEmail(gmail);
      if (!user) {
        user = await createUser({ id: crypto.randomUUID(), name: claims.name || gmail.split('@')[0], email: gmail, googleSub: claims.sub, picture: claims.picture || null, createdAt: new Date().toISOString() });
      } else {
        user = await linkGoogleUser(user, claims.sub, claims.picture);
      }
      await startSession(req, res, user);
      await logActivity(user.email, 'login_google', `Inicio de sesión con Google: ${user.email}`);
      return json(res, 200, { user: publicUser(user) }), true;
    }

    return json(res, 404, { error: 'No encontrado.' }), true;
  } catch (e) {
    return json(res, 400, { error: e.message }), true;
  }
}
