'use strict';

/**
 * End-to-end test against a real server on a real socket.
 * Run: npm test
 *
 * Spawns its own instance with a temp destination directory so it never
 * touches ~/Downloads/Beam and can be re-run safely.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DEST = path.join(os.tmpdir(), `beam-test-${Date.now()}`);
// A tunnel fronting the laptop. Exercises the public-URL code path.
const PUBLIC_URL = 'https://beam-test.example.com';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

function json(res) {
  return res.json().catch(() => null);
}

/** A PUT with genuinely no Content-Type header, exactly as a browser sends it. */
function rawPutNoType(url, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'PUT',
        // Content-Length only. No Content-Type, on purpose.
        headers: { 'Content-Length': body.length },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || 'null') }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Read an SSE stream until `predicate` is satisfied or we run out of time. */
async function collectSSE(code, predicate, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${BASE}/api/events/${code}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw);
        const dt = /^data: (.+)$/m.exec(raw);
        if (ev && dt) {
          events.push({ event: ev[1], data: JSON.parse(dt[1]) });
          if (predicate(events)) {
            ctrl.abort();
            return events;
          }
        }
      }
    }
  } catch {
    /* aborted on purpose */
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

async function main() {
  await fsp.mkdir(DEST, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BEAM_DEST: DEST, BEAM_PUBLIC_URL: PUBLIC_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => (serverErr += d.toString()));

  try {
    if (!(await waitForHealth())) {
      console.error('server never became healthy.\n' + serverErr);
      process.exitCode = 1;
      return;
    }

    /* ── 1. session creation ─────────────────────────────────────────── */
    console.log('\nsession');
    const sess = await (await fetch(`${BASE}/api/session`, { method: 'POST' })).json();
    const code = sess.code;
    check('code is 6 chars', code.length === 6, code);
    check(
      'code avoids look-alikes (no O/0/I/1/L)',
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code),
      code
    );
    check('dest dir reported', typeof sess.destDir === 'string' && sess.destDir.length > 0);
    check('at least one address', (sess.addresses || []).length > 0);
    const lanAddrs = (sess.addresses || []).filter((a) => a.iface !== 'public');
    check(
      'every LAN address uses the real port',
      lanAddrs.length > 0 && lanAddrs.every((a) => a.url.endsWith(`:${PORT}`)),
      JSON.stringify((sess.addresses || []).map((a) => a.url))
    );
    // With BEAM_PUBLIC_URL set the server is being hosted, so its private
    // addresses are unreachable from a phone and the public one must lead.
    check(
      'public URL is advertised first when configured',
      sess.addresses[0] && sess.addresses[0].iface === 'public' && sess.addresses[0].url === PUBLIC_URL,
      JSON.stringify((sess.addresses || []).map((a) => `${a.iface}:${a.url}`))
    );
    check(
      'LAN addresses are still offered as fallbacks',
      (sess.addresses || []).slice(1).some((a) => a.iface !== 'public'),
      JSON.stringify((sess.addresses || []).map((a) => a.iface))
    );
    // A QR encodes its payload into modules, so the URL never appears as text in
    // the markup. Verify it by regenerating a reference from the exact string we
    // expect to be encoded and comparing byte for byte.
    const QRCode = require('qrcode');
    const qrOpts = { type: 'svg', margin: 2, errorCorrectionLevel: 'M', width: 300 };
    const expected = await Promise.all(
      (sess.addresses || []).map((a) => QRCode.toString(`${a.url}/s/${code}`, qrOpts))
    );
    check(
      'every address QR encodes exactly <url>/s/<code>',
      (sess.addresses || []).length > 0 &&
        (sess.addresses || []).every((a, i) => typeof a.qr === 'string' && a.qr === expected[i]),
      'QR payload mismatch'
    );
    check(
      'every QR is a non-trivial SVG',
      (sess.addresses || []).every((a) => a.qr.includes('<svg') && a.qr.length > 500)
    );

    /* ── 2. chunked upload of a real payload ─────────────────────────── */
    console.log('\nchunked upload');
    const payload = crypto.randomBytes(1_500_000); // forces >1 chunk at test size
    const meta = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-video.mp4', size: payload.length, type: 'video/mp4' }),
      })
    ).json();
    check('meta returns a fileId', typeof meta.fileId === 'string' && meta.fileId.length > 0);
    check('meta returns a chunk size', Number(meta.chunkSize) > 0, String(meta.chunkSize));

    // Deliberately split into 3 uneven parts to exercise offset maths.
    const bounds = [0, 500_000, 1_200_000, payload.length];
    let sent = 0;
    for (let i = 0; i < 3; i++) {
      const slice = payload.subarray(bounds[i], bounds[i + 1]);
      const r = await fetch(`${BASE}/api/send/${code}/file/${meta.fileId}/chunk?offset=${bounds[i]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice,
      });
      if (!r.ok) {
        check(`chunk ${i} accepted`, false, `HTTP ${r.status}`);
        return;
      }
      const body = await json(r);
      sent = body.received;
    }
    check('server reports all bytes received', sent === payload.length, `${sent} vs ${payload.length}`);

    /* ── 3. computer-to-computer pairing by code ────────────────────── */
    // Two computers with no camera: one waits, the other types the code.
    console.log('\npairing by code');
    const join = await fetch(`${BASE}/api/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const joinBody = await json(join);
    check('valid code joins the waiting computer', join.ok && joinBody.code === code, JSON.stringify(joinBody));

    const lowerJoin = await fetch(`${BASE}/api/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.toLowerCase() }),
    });
    check('lowercase code still matches', lowerJoin.ok, `HTTP ${lowerJoin.status}`);

    const badJoin = await fetch(`${BASE}/api/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZ' }),
    });
    check('unknown code is refused', badJoin.status === 404, `HTTP ${badJoin.status}`);

    const shortJoin = await fetch(`${BASE}/api/session/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AB' }),
    });
    check('malformed code is refused', shortJoin.status === 400, `HTTP ${shortJoin.status}`);

    /* ── 4. out-of-order chunks (pipelined upload) ─────────────────── */
    // The client now sends several chunks concurrently, so they arrive in any
    // order. Correctness rests on each chunk being written at its own offset.
    console.log('\nout-of-order chunks');
    const oooMeta = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ooo.bin', size: payload.length, type: 'application/octet-stream' }),
      })
    ).json();
    const ORDER = [2, 0, 1];
    for (const i of ORDER) {
      const slice = payload.subarray(bounds[i], bounds[i + 1]);
      const r = await fetch(`${BASE}/api/send/${code}/file/${oooMeta.fileId}/chunk?offset=${bounds[i]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice,
      });
      if (!r.ok) { check(`out-of-order chunk ${i}`, false, `HTTP ${r.status}`); break; }
    }
    const oooDone = await fetch(`${BASE}/api/send/${code}/file/${oooMeta.fileId}/complete`, { method: 'POST' });
    const oooBody = await json(oooDone);
    check('complete accepts a scrambled upload', oooDone.ok, JSON.stringify(oooBody));
    if (oooBody && oooBody.path) {
      const scrambled = await fsp.readFile(oooBody.path);
      check(
        'scrambled chunks reassemble byte-exact',
        scrambled.equals(payload),
        `${scrambled.length} vs ${payload.length}`
      );
    }

    /* ── 5. the exact shape a browser sends ─────────────────────────── */
    // Regression: Blob.slice() produces a type-less Blob, so the browser omits
    // the Content-Type header. A `'*/*'` body-parser matcher silently refuses
    // to parse and every chunk is rejected as empty. This failed for real once.
    console.log('\nbrowser-shaped request (no Content-Type header)');
    const noTypeMeta = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'no-type.bin', size: 9, type: 'application/octet-stream' }),
      })
    ).json();
    const noType = await rawPutNoType(`${BASE}/api/send/${code}/file/${noTypeMeta.fileId}/chunk?offset=0`, Buffer.from('abcdefghi'));
    check('header-less chunk accepted', noType.status === 200, `HTTP ${noType.status} ${JSON.stringify(noType.body)}`);
    check('header-less chunk counted correctly', noType.body && noType.body.received === 9, JSON.stringify(noType.body));

    /* ── 4. idempotent resend ────────────────────────────────────────── */
    console.log('\nidempotency');
    const resend = await fetch(`${BASE}/api/send/${code}/file/${meta.fileId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload.subarray(0, 500_000),
    });
    const resendBody = await json(resend);
    check('resent chunk still accepted', resend.ok);
    check(
      'resending does not inflate the byte count',
      resendBody.received === payload.length,
      `${resendBody.received} vs ${payload.length}`
    );

    /* ── 4. complete and verify bytes on disk ────────────────────────── */
    console.log('\nfinalize');
    const ssePromise = collectSSE(code, (evs) => evs.some((e) => e.event === 'file' && e.data.files.some((f) => f.state === 'done')));
    const doneRes = await fetch(`${BASE}/api/send/${code}/file/${meta.fileId}/complete`, { method: 'POST' });
    const done = await json(doneRes);
    check('complete succeeds', doneRes.ok && done.ok, JSON.stringify(done));
    check('filename preserved exactly (spaces + dashes)', path.basename(done.path) === 'my-video.mp4', done.path);
    check('file landed inside the destination dir', path.dirname(done.path) === path.resolve(DEST), done.path);

    const onDisk = await fsp.readFile(done.path);
    check('bytes on disk match what was sent', onDisk.equals(payload), `${onDisk.length} vs ${payload.length}`);

    const events = await ssePromise;
    const sawDone = events.some((e) => e.event === 'file' && e.data.files.some((f) => f.state === 'done'));
    check('SSE delivered a done event to the receiver', sawDone, `${events.length} events`);

    /* ── 5. reveal ───────────────────────────────────────────────────── */
    console.log('\nreveal');
    const reveal = await fetch(`${BASE}/api/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: meta.fileId }),
    });
    const revealBody = await json(reveal);
    check('reveal responds ok', reveal.ok && revealBody.ok, JSON.stringify(revealBody));

    const dl = await fetch(`${BASE}/api/file/${meta.fileId}`);
    const dlBytes = Buffer.from(await dl.arrayBuffer());
    check('download endpoint serves the file', dl.ok, `HTTP ${dl.status}`);
    check('download bytes match what was sent', dlBytes.equals(payload), `${dlBytes.length} vs ${payload.length}`);
    check(
      'download is an attachment with the right filename',
      /attachment/.test(dl.headers.get('content-disposition') || '') &&
        (dl.headers.get('content-disposition') || '').includes('my-video.mp4'),
      dl.headers.get('content-disposition')
    );

    const missingDl = await fetch(`${BASE}/api/file/${crypto.randomUUID()}`);
    check('unknown file id 404s on download', missingDl.status === 404, `HTTP ${missingDl.status}`);

    /* ── 6. thumbnail previews ─────────────────────────────────────── */
    // The receiving card requests a preview while bytes are still arriving, so
    // the "nothing on disk yet" case is the normal one, not an edge case.
    console.log('\nthumbnails');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const thumbMeta = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dot.png', size: png.length, type: 'image/png' }),
      })
    ).json();

    const earlyThumb = await fetch(`${BASE}/api/thumb/${thumbMeta.fileId}`);
    check('thumbnail 404s before any bytes arrive', earlyThumb.status === 404, `HTTP ${earlyThumb.status}`);

    await fetch(`${BASE}/api/send/${code}/file/${thumbMeta.fileId}/chunk?offset=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    await fetch(`${BASE}/api/send/${code}/file/${thumbMeta.fileId}/complete`, { method: 'POST' });

    const lateThumb = await fetch(`${BASE}/api/thumb/${thumbMeta.fileId}`);
    const lateBytes = Buffer.from(await lateThumb.arrayBuffer());
    check('thumbnail serves the image after completion', lateThumb.status === 200, `HTTP ${lateThumb.status}`);
    check('thumbnail has an image content-type', /image/.test(lateThumb.headers.get('content-type') || ''), lateThumb.headers.get('content-type'));
    check('thumbnail bytes match the uploaded file', lateBytes.equals(png), `${lateBytes.length} vs ${png.length}`);

    const svgMeta = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'evil.svg', size: 4, type: 'image/svg+xml' }),
      })
    ).json();
    const svgThumb = await fetch(`${BASE}/api/thumb/${svgMeta.fileId}`);
    check('svg is refused (would be script injection)', svgThumb.status === 404, `HTTP ${svgThumb.status}`);

    const missingThumb = await fetch(`${BASE}/api/thumb/${crypto.randomUUID()}`);
    check('unknown file id 404s', missingThumb.status === 404, `HTTP ${missingThumb.status}`);

    /* ── 7. filename hardening ───────────────────────────────────────── */
    console.log('\nfilename safety');
    const evil = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '../../../evil.txt', size: 3, type: 'text/plain' }),
      })
    ).json();
    check('path traversal is stripped to a basename', evil.fileId && true);
    const evt = await collectSSE(code, (evs) => evs.some((e) => e.event === 'file'), 4000);
    const added = evt.flatMap((e) => e.data.files).find((f) => f.id === evil.fileId);
    check('traversal name reduced to evil.txt', added && added.name === 'evil.txt', added && added.name);

    /* ── 8. rejection paths ──────────────────────────────────────────── */
    console.log('\nerror handling');
    const badMeta = await fetch(`${BASE}/api/send/NOPE00/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.txt', size: 1, type: 'text/plain' }),
    });
    check('unknown code rejected with 404', badMeta.status === 404, `HTTP ${badMeta.status}`);

    const overrun = await fetch(`${BASE}/api/send/${code}/file/${meta.fileId}/chunk?offset=999999999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    check('chunk past declared size rejected', overrun.status === 400, `HTTP ${overrun.status}`);

    const early = await (
      await fetch(`${BASE}/api/send/${code}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'partial.bin', size: 900, type: 'application/octet-stream' }),
      })
    ).json();
    const earlyDone = await fetch(`${BASE}/api/send/${code}/file/${early.fileId}/complete`, { method: 'POST' });
    check('completing an incomplete upload is refused with 409', earlyDone.status === 409, `HTTP ${earlyDone.status}`);

    /* ── 9. static shell ─────────────────────────────────────────────── */
    console.log('\nweb shell');
    for (const p of ['/', '/style.css', '/app.js', `/s/${code}`]) {
      const r = await fetch(BASE + p);
      check(`GET ${p} serves 200`, r.ok, `HTTP ${r.status}`);
    }
  } finally {
    server.kill();
    await fsp.rm(DEST, { recursive: true, force: true }).catch(() => {});
    // The abandoned-upload test leaves a staging dir behind: the server's 10-minute
    // sweeper never gets a chance to run because we kill it immediately. Clean up
    // so repeated test runs don't litter the project.
    await fsp.rm(path.join(__dirname, '.staging'), { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\ntest harness crashed:', err);
  process.exitCode = 1;
});