import crypto from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);

const DATABASE_URL = process.env.DATABASE_URL || '';
export const hasPg = () => Boolean(DATABASE_URL);

const useSSL =
  DATABASE_URL.includes('render.com') ||
  DATABASE_URL.includes('sslmode=require') ||
  process.env.PGSSL === '1' ||
  process.env.NODE_ENV === 'production';

export const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: useSSL ? { rejectUnauthorized: false } : false,
    })
  : null;

async function hashSeedPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}

export async function initDatabase() {
  if (!pool) return false;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT,
      google_sub TEXT UNIQUE,
      picture TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      user_email TEXT,
      action_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Registros de prueba iniciales (no duplican si ya existen)
  const demoId = '00000000-0000-4000-8000-000000000001';
  const demoPass = await hashSeedPassword('FireWatch2026!');

  await pool.query(
    `
    INSERT INTO users (id, name, email, password, picture)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (email) DO NOTHING;
    `,
    [demoId, 'Operador Prueba', 'demo@firewatch.local', demoPass, null]
  );

  const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM activity_logs');
  if (countRes.rows[0]?.total === 0) {
    await pool.query(
      `
      INSERT INTO activity_logs (user_email, action_type, summary)
      VALUES
        ('demo@firewatch.local', 'seed_check', 'Registro inicial de prueba en PostgreSQL'),
        ('demo@firewatch.local', 'monitoring_zone', 'Zona de monitoreo inicial configurada: Sudamérica');
      `
    );
  }

  return true;
}
