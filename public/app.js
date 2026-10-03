'use strict';

/* ------------------------------------------------------------ formatting */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '—';
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtEta(bytesPerSec, remaining) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1024 || remaining <= 0) return '';
  const secs = remaining / bytesPerSec;
  if (secs < 60) return ` · ${Math.ceil(secs)}s left`;
  return ` · ${Math.ceil(secs / 60)}m left`;
}

function kindOf(type, name) {
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('image/')) return '🖼';
  if (type.startsWith('audio/')) return '🎵';
  if (type.includes('pdf')) return '📕';
  if (type.includes('zip') || /\.(zip|7z|rar|tar|gz)$/i.test(name)) return '🗜';
  return '📄';
}

function isImage(type) {
  return type.startsWith('image/') && !type.includes('svg');
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: options && options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

/* ─────────────────────────────  RECEIVE PANEL  ───────────────────────────── */

function initReceive() {
  const qrStack = document.getElementById('qr-stack');
  const pairCode = document.getElementById('pair-code');
  const fileList = document.getElementById('file-list');
  const receivedStat = document.getElementById('received-stat');
  const routeBadge = document.getElementById('route-badge');
  const moreBlock = document.getElementById('more-addresses');
  const moreLabel = document.getElementById('more-label');
  const altQrs = document.getElementById('alt-qrs');

  const cards = new Map();

  function renderQrCard(addr) {
    const card = document.createElement('div');
    card.className = 'qr-card';
    card.innerHTML = `${addr.qr}<div class="qr-iface">${addr.iface} · ${addr.address}</div>`;
    return card;
  }

  async function start() {
    let session;
    try {
      session = await api('/api/session', { method: 'POST' });
    } catch (err) {
      qrStack.innerHTML = `<div class="error">Could not start a session: ${err.message}</div>`;
      return;
    }

    pairCode.textContent = session.code;
    document.getElementById('dest-path').textContent = `saving to ${session.destDir}`;

    const addrs = session.addresses || [];
    if (!addrs.length) {
      qrStack.innerHTML =
        '<div class="error">No reachable network found. Connect to Wi-Fi, then reload.</div>';
      return;
    }

    qrStack.innerHTML = '';
    qrStack.appendChild(renderQrCard(addrs[0]));

    if (addrs.length > 1) {
      moreBlock.hidden = false;
      moreLabel.textContent = `Other addresses (${addrs.length - 1})`;
      altQrs.innerHTML = '';
      for (const a of addrs.slice(1)) altQrs.appendChild(renderQrCard(a));
    }

    listen(session.code);
  }

  function listen(code) {
    const es = new EventSource(`/api/events/${code}`);

    es.addEventListener('state', (e) => paint(JSON.parse(e.data)));
    es.addEventListener('file', (e) => paint(JSON.parse(e.data)));

    es.onopen = () => {
      routeBadge.textContent = 'direct · live';
      routeBadge.classList.add('live');
    };
    es.onerror = () => {
      routeBadge.textContent = 'reconnecting';
      routeBadge.classList.remove('live');
    };
  }

  function paint(view) {
    // Wording matters here: this server IS the destination computer, so bytes
    // are received, never relayed onward. Calling them "relayed" would
    // contradict the privacy claim the whole demo rests on.
    receivedStat.innerHTML = `received on this computer: <b>${fmtBytes(view.totalBytes)}</b>`;

    if (!view.files.length) return;
    const empty = document.getElementById('empty-state');
    if (empty) empty.remove();

    for (const f of view.files) {
      let card = cards.get(f.id);
      if (!card) {
        card = buildCard(f);
        cards.set(f.id, card);
        fileList.appendChild(card.root);
      }
      updateCard(card, f);
    }
  }

  function buildCard(f) {
    const root = document.createElement('div');
    root.className = 'file-card';

    const thumb = document.createElement('div');
    thumb.className = 'fc-thumb';

    const meta = document.createElement('div');
    meta.className = 'fc-meta';
    const name = document.createElement('div');
    name.className = 'fc-name';
    name.textContent = f.name;
    const sub = document.createElement('div');
    sub.className = 'fc-sub mono';
    meta.append(name, sub);

    const head = document.createElement('div');
    head.className = 'fc-head';
    head.append(thumb, meta);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    bar.appendChild(fill);

    const actions = document.createElement('div');
    actions.className = 'fc-actions';

    root.append(head, bar, actions);
    const card = { root, fill, sub, actions, thumb, lastState: null };
    loadThumb(card, f, 0);
    return card;
  }

  /**
   * Request a preview. Attempt 0 fires while bytes are still arriving, so the
   * server rightly 404s or serves a truncated file; the caller retries with
   * attempt 1 once the transfer completes. Only the final failure falls back
   * to an emoji -- assigning thumb.textContent would delete the <img> element
   * and leave nothing to retry with.
   */
  function loadThumb(card, f, attempt) {
    if (!isImage(f.type)) {
      if (!card.thumb.firstChild) card.thumb.textContent = kindOf(f.type, f.name);
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.onerror = () => {
      img.remove();
      if (attempt > 0 && !card.thumb.firstChild) card.thumb.textContent = kindOf(f.type, f.name);
    };
    img.src = `/api/thumb/${encodeURIComponent(f.id)}?r=${attempt}`;
    card.thumb.appendChild(img);
  }

  function updateCard(card, f) {
    const pct = f.size > 0 ? Math.round((f.received / f.size) * 100) : f.state === 'done' ? 100 : 0;
    card.fill.style.width = `${pct}%`;

    if (f.state === 'done') {
      card.root.classList.add('done');
      card.sub.textContent = `${fmtBytes(f.size)} · saved`;
      if (card.lastState !== 'done') {
        // Every byte is on disk now, so retry the preview that failed mid-upload.
        loadThumb(card, f, 1);
        card.actions.innerHTML = '';

        const open = document.createElement('button');
        open.className = 'btn';
        open.textContent = 'Show in folder';
        open.onclick = () =>
          api('/api/reveal', { method: 'POST', body: JSON.stringify({ fileId: f.id }) }).catch(() => {});

        card.actions.append(open);
      }
    } else {
      card.sub.textContent = `${fmtBytes(f.received)} of ${fmtBytes(f.size)} · ${pct}%`;
    }
    card.lastState = f.state;
  }

  start();
}

/* ─────────────────────────────  SEND PANEL  ───────────────────────────── */

/** How many chunks are in flight at once. */
const CONCURRENCY = 4;

function initSend(initialCode) {
  const chip = document.getElementById('code-chip');
  const codeEntry = document.getElementById('code-entry');
  const codeInput = document.getElementById('code-input');
  const codeGo = document.getElementById('code-go');
  const sendSub = document.getElementById('send-sub');
  const input = document.getElementById('file-input');
  const zone = document.getElementById('dropzone');
  const progress = document.getElementById('send-progress');
  const nameEl = document.getElementById('send-name');
  const pctEl = document.getElementById('send-pct');
  const barEl = document.getElementById('send-bar');
  const detailEl = document.getElementById('send-detail');
  const doneEl = document.getElementById('send-done');
  const errEl = document.getElementById('send-error');

  let code = (initialCode || '').toUpperCase();

  function setCode(next) {
    code = (next || '').toUpperCase();
    chip.textContent = code || '······';
    const ready = code.length === 6;
    zone.hidden = !ready;
    if (ready) {
      sendSub.textContent = `Sending to the device showing ${code}.`;
    } else {
      sendSub.textContent = 'Enter the code shown on the receiving device.';
    }
    return ready;
  }

  function fail(msg) {
    errEl.hidden = false;
    errEl.textContent = msg;
    zone.hidden = !setCode(code);
  }

  /** XHR, not fetch: iOS Safari implements upload progress only here. */
  function putChunk(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      // Blob.slice() yields a type-less Blob, so state the type explicitly
      // rather than letting the browser omit the header.
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`chunk rejected (${xhr.status}: ${xhr.responseText || 'no detail'})`));
      xhr.onerror = () => reject(new Error('connection lost'));
      xhr.upload.onprogress = onProgress;
      xhr.send(blob);
    });
  }

  async function upload(file) {
    if (!setCode(code)) return fail('Enter a 6-character pairing code first.');

    errEl.hidden = true;
    doneEl.hidden = true;
    progress.hidden = false;
    nameEl.textContent = file.name;
    barEl.style.width = '0%';
    pctEl.textContent = '0%';
    detailEl.textContent = 'preparing…';
    zone.hidden = true;

    const started = performance.now();
    // Per-offset progress, summed. Chunks land out of order, but the server
    // writes each one at its own offset, so ordering never mattered.
    const sentAt = new Map();

    const totalSent = () => {
      let t = 0;
      for (const v of sentAt.values()) t += v;
      return t;
    };

    const setProgress = () => {
      const sent = totalSent();
      const pct = file.size ? (sent / file.size) * 100 : 0;
      barEl.style.width = `${pct}%`;
      pctEl.textContent = `${Math.floor(pct)}%`;
      const secs = (performance.now() - started) / 1000;
      const speed = sent / Math.max(secs, 0.001);
      detailEl.textContent =
        `${fmtBytes(sent)} of ${fmtBytes(file.size)} · ${fmtSpeed(speed)}` + fmtEta(speed, file.size - sent);
    };

    let meta;
    try {
      meta = await api(`/api/send/${code}/meta`, {
        method: 'POST',
        body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
      });
    } catch (err) {
      const m = err.message || '';
      return fail(
        /expired|not found|no waiting/i.test(m)
          ? `No device is waiting with that code. Check it matches, then try again.`
          : m
      );
    }

    const chunkSize = meta.chunkSize || 5 * 1024 * 1024;
    const slices = [];
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      slices.push({ offset, blob: file.slice(offset, Math.min(offset + chunkSize, file.size)) });
    }

    try {
      // Pipeline a fixed number of chunks at a time. Each chunk is independent
      // and written at a fixed offset, so overlap is safe; this just stops us
      // paying a full round trip per chunk.
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, slices.length)) }, async () => {
        while (cursor < slices.length) {
          const { offset, blob } = slices[cursor++];
          await putChunk(
            `/api/send/${code}/file/${meta.fileId}/chunk?offset=${offset}`,
            blob,
            (e) => {
              sentAt.set(offset, e.loaded);
              setProgress();
            }
          );
          sentAt.set(offset, blob.size);
          setProgress();
        }
      });
      await Promise.all(workers);

      // Zero-byte files never enter the loop above.
      await api(`/api/send/${code}/file/${meta.fileId}/complete`, { method: 'POST' });
      setProgress();
      doneEl.hidden = false;
      detailEl.textContent = 'saved on the other device';
      setCode(code);
      input.value = '';
    } catch (err) {
      fail(`Transfer stopped: ${err.message}. Keep both screens open and try again.`);
    }
  }

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setCode(codeInput.value);
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') codeGo.click();
  });
  codeGo.addEventListener('click', async () => {
    if (!setCode(codeInput.value)) return;
    errEl.hidden = true;
    // Confirm the code is real before asking for a file, so a typo surfaces
    // immediately rather than after a large upload.
    try {
      await api('/api/session/join', { method: 'POST', body: JSON.stringify({ code }) });
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = /no waiting/i.test(err.message)
        ? 'No device is waiting with that code.'
        : err.message;
    }
  });

  input.addEventListener('change', () => {
    if (input.files && input.files[0]) upload(input.files[0]);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('hot'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('hot'); })
  );
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(f);
  });

  if (code) codeInput.value = code;
  setCode(code);
}

/* ─────────────────────────────  boot  ───────────────────────────── */

(function boot() {
  const panels = {
    receive: document.getElementById('panel-receive'),
    send: document.getElementById('panel-send'),
  };

  function show(which) {
    for (const [name, el] of Object.entries(panels)) el.hidden = name !== which;
    for (const t of document.querySelectorAll('.tab')) {
      const on = t.dataset.panel === which;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    }
  }

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => show(t.dataset.panel));
  }

  // The send panel must be wired on every page, not just /s/CODE: the Send tab
  // is how two computers pair when neither has a camera pointed at the other.
  // /s/CODE additionally prefills the code and skips straight to sending.
  const m = window.location.pathname.match(/^\/s\/([A-Za-z0-9]{4,10})\/?$/);
  initSend(m ? m[1].toUpperCase() : '');
  if (m) {
    show('send');
  } else {
    show('receive');
    initReceive();
  }
})();