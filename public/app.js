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

/* ─────────────────────────────  RECEIVE VIEW  ───────────────────────────── */

function initReceive() {
  const qrStack = document.getElementById('qr-stack');
  const pairCode = document.getElementById('pair-code');
  const fileList = document.getElementById('file-list');
  const relayStat = document.getElementById('received-stat');
  const routeBadge = document.getElementById('route-badge');
  const moreBlock = document.getElementById('more-addresses');
  const altQrs = document.getElementById('alt-qrs');

  const cards = new Map(); // fileId -> {root, bar, sub, pct}

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
        '<div class="error">No reachable network found. Connect this laptop to Wi-Fi, then reload.</div>';
      return;
    }

    qrStack.innerHTML = '';
    qrStack.appendChild(renderQrCard(addrs[0]));

    if (addrs.length > 1) {
      moreBlock.hidden = false;
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
    // Wording matters here: this server IS the destination laptop, so bytes are
    // received, never relayed onward. Calling them "relayed" would contradict
    // the privacy claim the whole demo rests on.
    relayStat.innerHTML = `received on this laptop: <b>${fmtBytes(view.totalBytes)}</b>`;

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
      updateCard(card, f, view);
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

  function updateCard(card, f, view) {
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

        const copy = document.createElement('button');
        copy.className = 'btn ghost';
        copy.textContent = 'Copy path';
        copy.style.marginLeft = '8px';
        copy.onclick = () => navigator.clipboard?.writeText(f.path || '');

        card.actions.append(open, copy);
      }
    } else {
      card.sub.textContent = `${fmtBytes(f.received)} of ${fmtBytes(f.size)} · ${pct}%`;
    }
    card.lastState = f.state;
  }

  start();
}

/* ─────────────────────────────  SEND VIEW  ───────────────────────────── */

function initSend(code) {
  document.getElementById('code-chip').textContent = code;

  const input = document.getElementById('file-input');
  const zone = document.getElementById('dropzone');
  const progress = document.getElementById('send-progress');
  const nameEl = document.getElementById('send-name');
  const pctEl = document.getElementById('send-pct');
  const barEl = document.getElementById('send-bar');
  const detailEl = document.getElementById('send-detail');
  const doneEl = document.getElementById('send-done');
  const errEl = document.getElementById('send-error');

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

  function fail(msg) {
    errEl.hidden = false;
    errEl.textContent = msg;
    zone.hidden = false;
  }

  /** XHR (not fetch) — iOS Safari implements upload progress only here. */
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
    errEl.hidden = true;
    doneEl.hidden = true;
    progress.hidden = false;
    nameEl.textContent = file.name;
    barEl.style.width = '0%';
    pctEl.textContent = '0%';
    detailEl.textContent = 'preparing…';
    zone.hidden = true;

    const started = performance.now();
    let sent = 0;

    const setProgress = () => {
      const pct = file.size ? (sent / file.size) * 100 : 0;
      barEl.style.width = `${pct}%`;
      pctEl.textContent = `${Math.floor(pct)}%`;
      const secs = (performance.now() - started) / 1000;
      detailEl.textContent = `${fmtBytes(sent)} of ${fmtBytes(file.size)} · ${fmtSpeed(sent / Math.max(secs, 0.001))}`;
    };

    let meta;
    try {
      meta = await api(`/api/send/${code}/meta`, {
        method: 'POST',
        body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
      });
    } catch (err) {
      return fail(
        err.message.includes('expired') || err.message.includes('not found')
          ? 'That code has expired. Ask for a fresh one on the laptop.'
          : err.message
      );
    }

    const chunkSize = meta.chunkSize || 5 * 1024 * 1024;

    try {
      for (let offset = 0; offset < file.size; ) {
        const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
        // Sequential on purpose: keeps peak memory flat and progress honest.
        await putChunk(
          `/api/send/${code}/file/${meta.fileId}/chunk?offset=${offset}`,
          slice,
          (e) => { sent = offset + e.loaded; setProgress(); }
        );
        sent = offset + slice.size;
        setProgress();
        offset += slice.size;
      }

      // Zero-byte files never enter the loop above.
      await api(`/api/send/${code}/file/${meta.fileId}/complete`, { method: 'POST' });
      sent = file.size;
      setProgress();
      doneEl.hidden = false;
      detailEl.textContent = 'saved on the laptop';
      zone.hidden = false;
      input.value = '';
    } catch (err) {
      fail(`Transfer stopped: ${err.message}. Keep both screens open and try again.`);
    }
  }
}

/* ─────────────────────────────  boot  ───────────────────────────── */

(function boot() {
  const m = window.location.pathname.match(/^\/s\/([A-Za-z0-9]{4,10})\/?$/);
  document.getElementById('view-receive').hidden = !!m;
  if (m) {
    document.getElementById('view-send').hidden = false;
    initSend(m[1].toUpperCase());
  } else {
    initReceive();
  }
})();