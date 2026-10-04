'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { exec } = require('child_process');

const express = require('express');
const QRCode = require('qrcode');

const { listAddresses } = require('./network');

// Guard the explicit zero: `process.env.PORT || 3000` would accept '0' (a
// non-empty string is truthy) and advertise unusable `http://host:0` URLs.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;

/**
 * Path this app is mounted under, e.g. '/beam'.
 *
 * Some hosts only forward :80, so the app has to live behind a path prefix on
 * an existing domain. nginx is configured to strip the prefix before proxying,
 * so the server itself stays prefix-agnostic; all this does is tell the page
 * where it lives, which the client reads back from <base href>.
 */
const BASE_PATH = ('/' + String(process.env.BEAM_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '')).replace(/\/$/, '');

// No 0/O, 1/I/L — these codes get read aloud across a room and typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const SESSION_TTL_MS = 10 * 60 * 1000;
const CHUNK_SIZE = 5 * 1024 * 1024;
const CHUNK_LIMIT = '12mb';

/** Where received files land — a real folder, so the demo can open it in Explorer. */
const DEST_DIR = process.env.BEAM_DEST || path.join(os.homedir(), 'Downloads', 'Beam');

/**
 * Per-file ceiling. Lowered when hosted on a small disk: at the default 2 GB a
 * couple of concurrent sessions could fill the volume and take the host down.
 */
const MAX_BYTES = Number(process.env.BEAM_MAX_BYTES) > 0 ? Number(process.env.BEAM_MAX_BYTES) : 2 * 1024 * 1024 * 1024;

/**
 * Every URL another device could reach this server on, most reliable first.
 *
 * Ordering depends on whether BEAM_PUBLIC_URL is set, because that changes what
 * "reachable" means:
 *
 * - Set: you are hosting this somewhere, and the private addresses below it
 *   (10.x, 192.168.x) are unreachable from any phone off that network. The
 *   public URL has to lead or the QR is a dead end.
 * - Unset: the server is the receiving device itself, so LAN addresses are the
 *   fast, offline-proof path and lead. A tunnel there is only a backup -- venue
 *   wifi frequently blocks tunnels outright.
 */
function allTargets() {
  const lan = listAddresses(PORT);
  const pub = (process.env.BEAM_PUBLIC_URL || '').trim().replace(/\/+$/, '');

  if (!pub) return lan;

  const publicTarget = { iface: 'public', address: pub.replace(/^https?:\/\//i, ''), url: pub };
  return [publicTarget, ...lan];
}

/** code -> { code, createdAt, files: Map<fileId, file>, clients: Set<res>, totalBytes } */
const sessions = new Map();

/* ------------------------------------------------------------------ helpers */

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    const bytes = crypto.randomBytes(CODE_LEN);
    for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[bytes[i] % ALPHABET.length];
    if (!sessions.has(c)) return c;
  }
  throw new Error('could not allocate a unique code');
}

/** Characters that are illegal in a Windows filename, plus both path separators. */
const BAD_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/** Strip directory components and characters that break Windows paths. */
function safeName(name) {
  // Filtered by code point rather than a regex escape, so this file stays plain
  // ASCII. Spaces and dashes survive on purpose: mangling "my-video.mp4" reads
  // as a bug during a live demo.
  const base = Array.from(path.basename(String(name || 'file')))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      const isControl = code < 32 || code === 127;
      return !isControl && !BAD_FILENAME_CHARS.has(ch);
    })
    .join('')
    .trim();
  return base.slice(0, 180) || 'file';
}

/** Find a file by id across every live session. */
function findFile(fileId) {
  for (const session of sessions.values()) {
    const file = session.files.get(fileId);
    if (file) return file;
  }
  return null;
}

/** `report.mp4` -> `report (1).mp4` when the destination already has one. */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.extname(name) ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

function getSession(code) {
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) return null;
  return s;
}

function broadcast(session, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) {
    try {
      res.write(payload);
    } catch {
      session.clients.delete(res);
    }
  }
}

function sessionView(session) {
  return {
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.createdAt + SESSION_TTL_MS,
    totalBytes: session.totalBytes,
    files: [...session.files.values()].map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      type: f.type,
      received: f.received,
      state: f.state,
      path: f.path || null,
    })),
  };
}

/* ------------------------------------------------------------------- server */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

/** Serve the page with a <base href> matching where it is actually mounted. */
async function sendIndex(res) {
  try {
    let html = await fsp.readFile(INDEX_PATH, 'utf8');
    const base = `${BASE_PATH || ''}/`;
    const tag = `<base href="${base}">`;
    html = html.includes('<base ')
      ? html.replace(/<base href="[^"]*">/, tag)
      : html.replace(/<title>/, `${tag}\n<title>`);
    res.type('html').set('Cache-Control', 'no-store, must-revalidate').send(html);
  } catch (err) {
    res.status(500).type('text/plain').send(`could not read index.html: ${err.message}`);
  }
}

// The page must be rendered by sendIndex so it carries the right <base href>.
// This has to be registered *before* express.static, otherwise the static
// handler answers '/' with the raw file and the base tag is never injected.
app.get('/', (req, res) => sendIndex(res));
app.get('/s/:code', (req, res) => sendIndex(res));

// Never cache the client bundle. During a live demo a stale cached app.js is
// far worse than a few extra kilobytes: the page silently runs old code and
// the fix you just made appears not to work.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
  })
);

app.get('/api/network', (req, res) => {
  res.json({ port: PORT, destDir: DEST_DIR, addresses: allTargets() });
});

/** Current state of a room. Used by the client's polling fallback for SSE. */
app.get('/api/session/:code', (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'session not found or expired' });
  res.set('Cache-Control', 'no-store').json(sessionView(session));
});

/** Join an existing room by code, so two computers can pair without a QR scan. */
app.post('/api/session/join', (req, res) => {
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
    return res.status(400).json({ error: 'codes are 6 characters' });
  }
  const session = getSession(code);
  if (!session) return res.status(404).json({ error: 'no waiting laptop with that code' });
  res.json({ code: session.code, expiresAt: session.createdAt + SESSION_TTL_MS });
});

/** One round trip: the code *and* a scannable QR for every address it is valid on. */
app.post('/api/session', async (req, res) => {
  try {
    const code = makeCode();
    const session = { code, createdAt: Date.now(), files: new Map(), clients: new Set(), totalBytes: 0 };
    sessions.set(code, session);

    const addresses = await Promise.all(
      allTargets().map(async (a) => ({
        ...a,
        qr: await QRCode.toString(`${a.url}/s/${code}`, {
          type: 'svg',
          margin: 2,
          errorCorrectionLevel: 'M',
          width: 300,
        }),
      }))
    );

    res.json({ code, expiresAt: session.createdAt + SESSION_TTL_MS, destDir: DEST_DIR, addresses });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message) });
  }
});

/** Live progress for the receiving laptop. */
app.get('/api/events/:code', (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'session not found or expired' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(sessionView(session))}\n\n`);

  session.clients.add(res);

  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* closed */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(beat);
    session.clients.delete(res);
  });
});

/** Sender announces a file before uploading bytes. */
app.post('/api/send/:code/meta', async (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'session not found or expired' });

  const { name, size, type } = req.body || {};
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return res.status(400).json({ error: 'bad size' });
  if (bytes > MAX_BYTES) return res.status(413).json({ error: 'file too large' });

  const file = {
    id: crypto.randomUUID(),
    name: safeName(name),
    size: bytes,
    type: String(type || 'application/octet-stream').slice(0, 120),
    received: 0,
    state: 'receiving',
    path: null,
    stagingDir: path.join(__dirname, '.staging', session.code, crypto.randomUUID()),
  };
  await fsp.mkdir(file.stagingDir, { recursive: true });
  file.stagingPath = path.join(file.stagingDir, 'payload');

  session.files.set(file.id, file);
  broadcast(session, 'file', sessionView(session));
  res.json({ fileId: file.id, chunkSize: CHUNK_SIZE });
});

/**
 * Raw chunk. Idempotent: a re-sent offset rewrites the same bytes, never
 * double-counts.
 *
 * `type` is a predicate rather than a content-type string. A browser sending a
 * Blob -- which is what Blob.slice() always produces, carrying an empty type --
 * omits the Content-Type header entirely, and body-parser refuses to match a
 * wildcard type against a request that has no such header. That leaves
 * req.body as {} and rejects every chunk as empty. Match regardless of the
 * header so the client can stay simple.
 */
app.put('/api/send/:code/file/:id/chunk', express.raw({ type: () => true, limit: CHUNK_LIMIT }), async (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'session not found or expired' });

  const file = session.files.get(req.params.id);
  if (!file) return res.status(404).json({ error: 'unknown file' });

  const offset = Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'bad offset' });

  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty chunk' });
  if (offset + buf.length > file.size) return res.status(400).json({ error: 'chunk overruns declared size' });

  const handle = await fsp.open(file.stagingPath, 'r+').catch(async () => fsp.open(file.stagingPath, 'w+'));
  try {
    await handle.write(buf, 0, buf.length, offset);
  } finally {
    await handle.close();
  }

  // Recount from the file on disk: correct even after a resent chunk.
  const { size: onDisk } = await fsp.stat(file.stagingPath);
  file.received = Math.min(onDisk, file.size);
  session.totalBytes += Math.max(0, file.received - (file._prev || 0));
  file._prev = file.received;

  broadcast(session, 'file', sessionView(session));
  res.json({ received: file.received });
});

/** Finalize: verify we have every byte, move it into place, broadcast the real path. */
app.post('/api/send/:code/file/:id/complete', async (req, res) => {
  const session = getSession(req.params.code);
  if (!session) return res.status(404).json({ error: 'session not found or expired' });

  const file = session.files.get(req.params.id);
  if (!file) return res.status(404).json({ error: 'unknown file' });

  if (file.received < file.size) {
    return res.status(409).json({ error: 'incomplete upload', received: file.received, size: file.size });
  }

  await fsp.mkdir(DEST_DIR, { recursive: true });
  const finalPath = await uniquePath(DEST_DIR, file.name);
  await fsp.rename(file.stagingPath, finalPath).catch(async (err) => {
    // Cross-device rename can fail; fall back to a copy.
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(file.stagingPath, finalPath);
  });
  await fsp.rm(file.stagingDir, { recursive: true, force: true }).catch(() => {});

  file.path = finalPath;
  file.state = 'done';
  file._prev = undefined;

  broadcast(session, 'file', sessionView(session));
  res.json({ ok: true, path: finalPath });
});

/** Inline image preview on the receiving laptop. */
app.get('/api/thumb/:id', (req, res) => {
  const file = findFile(req.params.id);
  if (!file || !file.type.startsWith('image/') || file.type.includes('svg')) {
    return res.status(404).json({ error: 'no image with that id' });
  }
  const target = file.path || file.stagingPath;
  // Containment check: the resolved path must live where we put it.
  const root = path.resolve(file.path ? DEST_DIR : path.join(__dirname, '.staging'));
  if (!path.resolve(target).startsWith(root)) return res.status(403).json({ error: 'refused' });
  if (!fs.existsSync(target)) return res.status(404).end();
  res.sendFile(path.resolve(target));
});

/**
 * Download a finished file.
 *
 * This is the path that matters when Beam is hosted somewhere else: a remote
 * server cannot open Explorer on the receiving machine, so the receiving
 * browser pulls the bytes and the OS files them under the receiver's own
 * Downloads folder. Works identically for a locally-run server.
 */
app.get('/api/file/:id', (req, res) => {
  const file = findFile(req.params.id);
  if (!file || !file.path) return res.status(404).json({ error: 'no completed file with that id' });
  const target = path.resolve(file.path);
  if (!target.startsWith(path.resolve(DEST_DIR))) return res.status(403).json({ error: 'refused' });
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'file no longer exists' });

  res.download(target, file.name, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

/** Light the file up in Windows Explorer. Only meaningful on the same machine. */
app.post('/api/reveal', async (req, res) => {
  const { fileId } = req.body || {};
  const file = findFile(fileId);
  if (!file || !file.path) return res.status(404).json({ error: 'no completed file with that id' });
  const target = file.path;
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'file no longer exists' });

  if (process.platform === 'win32') {
    // Note: the comma must touch the path, and quotes are required for spaces.
    exec(`explorer.exe /select,"${target}"`, () => {});
    return res.json({ ok: true, path: target });
  }
  if (process.platform === 'darwin') {
    exec(`open -R "${target}"`, () => {});
    return res.json({ ok: true, path: target });
  }
  exec(`xdg-open "${path.dirname(target)}"`, () => {});
  res.json({ ok: true, path: target });
});

app.get('/api/health', (req, res) =>
  res.json({ ok: true, sessions: sessions.size, destDir: DEST_DIR, maxBytes: MAX_BYTES })
);

/* --------------------------------------------------------------- lifecycle */

async function sweep() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (now - session.createdAt <= SESSION_TTL_MS) continue;
    for (const res of session.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    sessions.delete(code);
    await fsp.rm(path.join(__dirname, '.staging', code), { recursive: true, force: true }).catch(() => {});
  }
}

if (require.main === module) {
  fsp.mkdir(DEST_DIR, { recursive: true }).catch(() => {});
  setInterval(sweep, 30000).unref();

  app.listen(PORT, '0.0.0.0', async () => {
    const addresses = allTargets();
    const line = '─'.repeat(52);
    console.log(`\n  Beam  ${line}`);
    console.log(`  ${''}  Saving to  ${DEST_DIR}`);
    console.log(`  ${''}  Scan one of these on your phone:\n`);
    for (const a of addresses) {
      console.log(`    ${a.iface.padEnd(12)} ${a.url}/s/CODE`);
    }
    if (!addresses.length) {
      console.log('    (no usable network interface found — connect to Wi-Fi)');
    }
    console.log(`\n  Open the receive screen on this laptop:  http://localhost:${PORT}\n`);
  });
}

module.exports = { app };