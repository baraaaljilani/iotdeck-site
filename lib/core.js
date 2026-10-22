// IoTDeck — Cloudflare-only IoT monitoring and control platform.
// Routes: auth (email + Google), devices, readings ingest, widgets, live WebSocket hub.

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers WebCrypto maximum; stored per user
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10; // per IP and per email, per window
const READING_RETENTION_DAYS = 14;
const MAX_BODY_BYTES = 4096;
const MIN_SEND_INTERVAL_MS = 5000;
const MAX_FIELDS = 24;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const WIDGET_TYPES = new Set(['value', 'gauge', 'line', 'toggle', 'button']);
const FIELD_RE = /^[a-zA-Z0-9_]{1,32}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function route(req, env, url) {
  const { pathname: p } = url;
  const m = req.method;

  // Cross-site request guard for state-changing requests
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  }

  // Auth
  if (p === '/api/auth/signup' && m === 'POST') return signup(req, env);
  if (p === '/api/auth/login' && m === 'POST') return login(req, env);
  if (p === '/api/auth/logout' && m === 'POST') return logout(req, env);
  if (p === '/api/auth/google' && m === 'GET') return googleStart(env);
  if (p === '/api/auth/google/callback' && m === 'GET') return googleCallback(req, env, url);
  if (p === '/api/me' && m === 'GET') {
    const user = await requireUser(req, env);
    return json({ user });
  }

  // Device ingest (device key auth)
  if (p === '/ingest' && m === 'POST') return ingest(req, env);

  // Live sockets
  let match = p.match(/^\/ws\/device\/([a-f0-9]{16})$/);
  if (match && m === 'GET') return deviceSocket(req, env, match[1]);
  match = p.match(/^\/ws\/view\/([a-f0-9]{16})$/);
  if (match && m === 'GET') return viewSocket(req, env, match[1]);

  // Devices
  if (p === '/api/devices' && m === 'GET') return listDevices(req, env);
  if (p === '/api/devices' && m === 'POST') return createDevice(req, env);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})$/);
  if (match && m === 'DELETE') return deleteDevice(req, env, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/readings$/);
  if (match && m === 'GET') return listReadings(req, env, url, match[1]);

  match = p.match(/^\/api\/devices\/([a-f0-9]{16})\/command$/);
  if (match && m === 'POST') return sendCommand(req, env, match[1]);

  // Widgets
  if (p === '/api/widgets' && m === 'GET') return listWidgets(req, env);
  if (p === '/api/widgets' && m === 'POST') return createWidget(req, env);

  match = p.match(/^\/api\/widgets\/([a-f0-9]{32})$/);
  if (match && m === 'DELETE') return deleteWidget(req, env, match[1]);

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Helpers: responses, encoding, hashing, cookies
// ---------------------------------------------------------------------------

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toB64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomToken(n = 32) {
  return toB64Url(randomBytes(n));
}

function randomHex(n) {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toB64Url(new Uint8Array(bits));
}

// Fixed-window counter per key. Returns false when the limit is exceeded.
async function allowAttempt(env, key) {
  const now = Date.now();
  const bucket = await sha256Hex(key);
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`,
  )
    .bind(bucket, now, now - AUTH_WINDOW_MS, now - AUTH_WINDOW_MS, now)
    .run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket).first();
  return row.count <= AUTH_MAX_ATTEMPTS;
}

async function guardAuth(req, env, email) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const ipOk = await allowAttempt(env, `ip:${ip}`);
  const emailOk = email ? await allowAttempt(env, `email:${email}`) : true;
  if (!ipOk || !emailOk) {
    throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.', { 'retry-after': '900' });
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function sessionCookie(token) {
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearSessionCookie() {
  return 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

async function readJson(req, { requireJsonType = true } = {}) {
  if (requireJsonType) {
    const type = req.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON');
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return body;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Sessions and auth
// ---------------------------------------------------------------------------

async function createSession(env, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, now + SESSION_DAYS * 86400000, now)
    .run();
  return token;
}

async function currentUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

async function requireUser(req, env) {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'Sign in required');
  return user;
}

async function signup(req, env) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const name = cleanText(body.name, 60) || (email ? email.split('@')[0] : '');
  if (!email) throw new HttpError(400, 'Enter a valid email address');
  if (password.length < 10 || password.length > 200) {
    throw new HttpError(400, 'Password must be 10 to 200 characters');
  }
  await guardAuth(req, env, email);

  const salt = randomBytes(16);
  const hash = await hashPassword(password, salt);
  const id = randomHex(16);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, email, name, hash, toB64Url(salt), PBKDF2_ITERATIONS, Date.now())
      .run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'Could not create this account. Try signing in instead.');
    }
    throw err;
  }

  const token = await createSession(env, id);
  return json({ user: { id, email, name } }, 201, { 'set-cookie': sessionCookie(token) });
}

async function login(req, env) {
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const fail = () => new HttpError(401, 'Email or password is incorrect');
  if (!email || !password) throw fail();
  await guardAuth(req, env, email);

  const row = await env.DB.prepare(
    'SELECT id, email, name, password_hash, password_salt, password_iterations FROM users WHERE email = ?',
  )
    .bind(email)
    .first();
  if (!row || !row.password_hash) throw fail();

  const hash = await hashPassword(password, fromB64Url(row.password_salt), row.password_iterations);
  if (!constantTimeEqual(hash, row.password_hash)) throw fail();

  const token = await createSession(env, row.id);
  return json(
    { user: { id: row.id, email: row.email, name: row.name } },
    200,
    { 'set-cookie': sessionCookie(token) },
  );
}

async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

// Google sign-in (OAuth 2.0 authorization code flow)

function googleStart(env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured yet');
  const state = randomToken(24);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      'set-cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=600`,
    },
  });
}

async function googleCallback(req, env, url) {
  const expected = getCookie(req, 'oauth_state');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!expected || !state || !code || !constantTimeEqual(expected, state)) {
    throw new HttpError(400, 'Sign-in expired. Please try again.');
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'Google sign-in is not configured yet');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new HttpError(502, 'Google sign-in failed. Please try again.');
  const tokens = await tokenRes.json();

  // The id_token came straight from Google's token endpoint over TLS, authenticated
  // with our client secret, so its claims can be read directly (OpenID Connect spec).
  const claims = decodeJwtPayload(tokens.id_token);
  const validIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  const email = normalizeEmail(claims.email);
  if (!validIssuer || claims.aud !== env.GOOGLE_CLIENT_ID || !emailVerified || !email || !claims.sub) {
    throw new HttpError(400, 'Google account could not be verified');
  }

  let user = await env.DB.prepare('SELECT id, email, name, google_sub FROM users WHERE google_sub = ?')
    .bind(claims.sub)
    .first();
  if (!user) {
    user = await env.DB.prepare('SELECT id, email, name, google_sub FROM users WHERE email = ?')
      .bind(email)
      .first();
    if (user) {
      await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(claims.sub, user.id).run();
    } else {
      const id = randomHex(16);
      const name = cleanText(claims.name, 60) || email.split('@')[0];
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, email, name, claims.sub, Date.now())
        .run();
      user = { id, email, name };
    }
  }

  const token = await createSession(env, user.id);
  return new Response(null, {
    status: 302,
    headers: [
      ['location', '/dashboard'],
      ['set-cookie', sessionCookie(token)],
      ['set-cookie', 'oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=0'],
    ],
  });
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') throw new HttpError(502, 'Google sign-in failed');
  const parts = jwt.split('.');
  if (parts.length < 2) throw new HttpError(502, 'Google sign-in failed');
  return JSON.parse(decoder.decode(fromB64Url(parts[1])));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

async function ownedDevice(env, userId, deviceId) {
  const device = await env.DB.prepare('SELECT id, name, user_id FROM devices WHERE id = ?')
    .bind(deviceId)
    .first();
  if (!device || device.user_id !== userId) throw new HttpError(404, 'Device not found');
  return device;
}

function hubStub(env, deviceId) {
  return env.HUB.get(env.HUB.idFromName(deviceId));
}

async function listDevices(req, env) {
  const user = await requireUser(req, env);
  const { results } = await env.DB.prepare(
    'SELECT id, name, latest, last_seen, created_at FROM devices WHERE user_id = ? ORDER BY created_at',
  )
    .bind(user.id)
    .all();
  const now = Date.now();
  return json({
    devices: results.map((d) => ({
      id: d.id,
      name: d.name,
      latest: d.latest ? JSON.parse(d.latest) : null,
      lastSeen: d.last_seen || null,
      online: d.last_seen > 0 && now - d.last_seen < ONLINE_WINDOW_MS,
      createdAt: d.created_at,
    })),
  });
}

async function createDevice(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const name = cleanText(body.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Give the device a name (2 to 60 characters)');

  const id = randomHex(8);
  const key = `iot_${randomToken(24)}`; // shown once, only the hash is stored
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, name, key_hash, last_seen, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  )
    .bind(id, user.id, name, await sha256Hex(key), Date.now())
    .run();

  return json({ device: { id, name }, key }, 201);
}

async function deleteDevice(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM widgets WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM readings WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId),
  ]);
  return json({ ok: true });
}

async function listReadings(req, env, url, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 1), 500);
  const { results } = await env.DB.prepare(
    'SELECT ts, payload FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT ?',
  )
    .bind(deviceId, limit)
    .all();
  return json({
    readings: results
      .reverse()
      .map((r) => ({ ts: r.ts, data: JSON.parse(r.payload) })),
  });
}

async function sendCommand(req, env, deviceId) {
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  const body = await readJson(req);
  const field = typeof body.field === 'string' ? body.field : '';
  const value = body.value;
  if (!FIELD_RE.test(field)) throw new HttpError(400, 'Invalid control name');
  if (!['boolean', 'number', 'string'].includes(typeof value)) {
    throw new HttpError(400, 'Value must be a number, text, or true/false');
  }
  const res = await hubStub(env, deviceId).fetch('https://hub/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
  return json(await res.json());
}

// ---------------------------------------------------------------------------
// Device ingest (called by ESP32 / other devices with their key)
// ---------------------------------------------------------------------------

function sanitizeReading(body) {
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(body)) {
    if (count >= MAX_FIELDS) break;
    if (!FIELD_RE.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.round(value * 10000) / 10000;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 64);
    } else {
      continue;
    }
    count++;
  }
  if (count === 0) throw new HttpError(400, 'No valid fields. Send JSON like {"temp": 24.5}');
  return out;
}

async function ingest(req, env) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key.startsWith('iot_')) throw new HttpError(401, 'Missing device key');

  const device = await env.DB.prepare('SELECT id, last_seen FROM devices WHERE key_hash = ?')
    .bind(await sha256Hex(key))
    .first();
  if (!device) throw new HttpError(401, 'Unknown device key');

  const now = Date.now();
  const elapsed = now - (device.last_seen || 0);
  if (device.last_seen && elapsed < MIN_SEND_INTERVAL_MS) {
    const wait = Math.ceil((MIN_SEND_INTERVAL_MS - elapsed) / 1000);
    throw new HttpError(429, 'Sending too fast. Slow down.', { 'retry-after': String(wait) });
  }

  const data = sanitizeReading(await readJson(req, { requireJsonType: false }));
  const payload = JSON.stringify(data);

  await env.DB.batch([
    env.DB.prepare('INSERT INTO readings (device_id, ts, payload) VALUES (?, ?, ?)').bind(device.id, now, payload),
    env.DB.prepare('UPDATE devices SET latest = ?, last_seen = ? WHERE id = ?').bind(payload, now, device.id),
  ]);

  // Push to dashboards and collect any queued commands for this device
  const res = await hubStub(env, device.id).fetch('https://hub/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ts: now, data }),
  });
  const { commands } = await res.json();
  if (Math.random() < 0.02) await cleanup(env);
  return json({ ok: true, ts: now, commands });
}

// ---------------------------------------------------------------------------
// Live sockets (proxied to the device's Durable Object)
// ---------------------------------------------------------------------------

async function deviceSocket(req, env, deviceId) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade');
  }
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const device = await env.DB.prepare('SELECT id FROM devices WHERE id = ? AND key_hash = ?')
    .bind(deviceId, await sha256Hex(key))
    .first();
  if (!device) throw new HttpError(401, 'Unknown device key');
  return hubStub(env, deviceId).fetch(new Request('https://hub/device', req));
}

async function viewSocket(req, env, deviceId) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade');
  }
  const user = await requireUser(req, env);
  await ownedDevice(env, user.id, deviceId);
  return hubStub(env, deviceId).fetch(new Request('https://hub/viewer', req));
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

async function listWidgets(req, env) {
  const user = await requireUser(req, env);
  const { results } = await env.DB.prepare(
    'SELECT id, device_id, type, field, title, config, position FROM widgets WHERE user_id = ? ORDER BY position, created_at',
  )
    .bind(user.id)
    .all();
  return json({
    widgets: results.map((w) => ({
      id: w.id,
      deviceId: w.device_id,
      type: w.type,
      field: w.field,
      title: w.title,
      config: JSON.parse(w.config || '{}'),
      position: w.position,
    })),
  });
}

async function createWidget(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  const type = typeof body.type === 'string' ? body.type : '';
  const field = typeof body.field === 'string' ? body.field : '';
  const title = cleanText(body.title, 40) || field;

  if (!WIDGET_TYPES.has(type)) throw new HttpError(400, 'Unknown widget type');
  if (!FIELD_RE.test(field)) throw new HttpError(400, 'Invalid field name');
  await ownedDevice(env, user.id, deviceId);

  const config = {};
  if (type === 'gauge') {
    config.min = Number.isFinite(Number(body.min)) ? Number(body.min) : 0;
    config.max = Number.isFinite(Number(body.max)) && Number(body.max) > config.min ? Number(body.max) : 100;
    config.unit = cleanText(body.unit, 8);
  }
  if (type === 'value' || type === 'line') config.unit = cleanText(body.unit, 8);
  if (type === 'button') config.pulse = true;

  const id = randomHex(16);
  const pos = await env.DB.prepare('SELECT COUNT(*) AS n FROM widgets WHERE user_id = ?').bind(user.id).first();
  await env.DB.prepare(
    'INSERT INTO widgets (id, user_id, device_id, type, field, title, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, deviceId, type, field, title, JSON.stringify(config), pos.n, Date.now())
    .run();

  return json({ widget: { id, deviceId, type, field, title, config, position: pos.n } }, 201);
}

async function deleteWidget(req, env, widgetId) {
  const user = await requireUser(req, env);
  await env.DB.prepare('DELETE FROM widgets WHERE id = ? AND user_id = ?').bind(widgetId, user.id).run();
  return json({ ok: true });
}


export async function cleanup(env) {
  const now = Date.now();
  const cutoff = now - READING_RETENTION_DAYS * 86400000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM readings WHERE ts < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - AUTH_WINDOW_MS),
  ]);
}

// Entry used by Pages Functions wrappers
export async function handle(request, env) {
  const url = new URL(request.url);
  try {
    return await route(request, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, err.headers);
    console.error("Unhandled error", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
