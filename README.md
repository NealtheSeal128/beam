# Beam

**AirDrop without the Apple tax.** Point your phone's camera at your laptop's
screen, and the file lands on your desktop. No account, no app install, no
cloud, no Apple device required.

Built for the Dublin HacX hackathon.

---

## Run it

```bash
npm install
npm start
```

The server prints the addresses your phone can reach:

```
  Beam  ────────────────────────────────────────────────────
    Saving to  C:\Users\you\Downloads\Beam
    Scan one of these on your phone:

    Ethernet 5   http://192.168.56.1:3000/s/CODE
    Wi-Fi        http://10.171.164.200:3000/s/CODE

  Open the receive screen on this laptop:  http://localhost:3000
```

1. On the **laptop**, open `http://localhost:3000`. A QR code and a 6-character
   code appear.
2. On the **phone**, scan the QR with the normal camera app. The send screen
   opens with no app and no login.
3. Pick a file. Watch it land on the laptop in real time.
4. Hit **Show in folder** — Windows Explorer opens with the file selected.

Files are saved to `~/Downloads/Beam/`. Override with `BEAM_DEST`.

| Command | What it does |
|---|---|
| `npm start` | Start the server (port 3000, or `$PORT`) |
| `npm test` | End-to-end test against a real socket |

---

## The demo (90 seconds)

> "Show of hands — who's ever needed to get a file off their phone onto their
> laptop, and doesn't own two Apple devices? … That's a real problem, and the
> reason it's hard isn't the transfer. It's the pairing.
>
> AirDrop's real magic isn't Bluetooth. It's that it works with zero thought. So
> we stole *that* — and threw away the ecosystem lock.
>
> *[Scan the QR.]* File's on my laptop. No account, no app, no cloud. The bytes
> went phone to laptop over my Wi-Fi and stopped.
>
> *[Hit Show in folder — Explorer lights up the file.]* That folder is real.
>
> And here's what we're actually proud of: you never picked a transport, never
> signed in, never waited on a progress bar you had to think about. It just
> worked — which was the entire point of AirDrop all along."

**Before you present, do this:** put your phone and laptop on a **phone
hotspot**, not venue Wi-Fi. Client isolation between devices is the one thing
that will reliably break this on stage, and a hotspot removes the risk for free.

---

## How it works

```
laptop (receiver)                          phone (sender)
┌──────────────────────┐                   ┌──────────────────────┐
│  Express server      │◀── HTTP chunked ──│  same page, /s/CODE  │
│  saves to ~/Downloads│      over LAN     │  <input type=file>   │
└──────────────────────┘                   └──────────────────────┘
        ▲
        │ QR encodes http://<lan-ip>:3000/s/<code>
```

The QR carries the whole pairing — scanning it is the auth. The 6-character
code is the fallback for when a camera won't focus.

**One server, many addresses.** The receiving screen renders a QR for *every*
IPv4 address the laptop has, so a judge on a network that blocks one address
just scans another. This is the single most important robustness decision in
the project.

**Chunked uploads.** Files go up in 5 MB chunks, sequentially. That keeps peak
memory flat on a phone, gives honest progress, and makes each offset idempotent
— a re-sent chunk rewrites the same bytes instead of corrupting the file.

**Live progress.** The receiving laptop subscribes over Server-Sent Events, so
the file card animates in as bytes land rather than appearing at the end.

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/network` | Reachable addresses |
| `POST` | `/api/session` | Create a room; returns code + a QR per address |
| `GET` | `/api/events/:code` | SSE stream: `state` / `file` |
| `POST` | `/api/send/:code/meta` | Announce `{name,size,type}` → `fileId`, `chunkSize` |
| `PUT` | `/api/send/:code/file/:id/chunk?offset=N` | Raw chunk, idempotent by offset |
| `POST` | `/api/send/:code/file/:id/complete` | Verify length, move into place |
| `GET` | `/api/thumb/:id` | Inline preview for images |
| `POST` | `/api/reveal` | Open Explorer with the file selected |

---

## Deliberate non-goals

- **Bluetooth / Web Bluetooth.** Safari has no Web Bluetooth at all, so an
  iPhone↔laptop pairing can never use it. Even in Chrome it moves roughly
  300 KB/s, so a 40 MB video would take two minutes. It is the wrong mechanism
  for the job, not a missing feature.
- **Cloud relay.** There is no cloud in this build. The receiving laptop is the
  server, which is what makes the privacy claim true rather than decorative.
  A relay mode (tunnelled to the same laptop) is the natural next step.
- **Accounts.** The 6-character code is the whole auth model.

## Known limits

- Both devices must be on a network that can reach each other. No internet
  required; cross-network is not implemented yet.
- 2 GB per file cap.
- A 20-minute session timeout; expired codes are refused with a clear message.
- Tested against Chromium. Safari/Firefox should work — the transfer uses only
  `fetch`, `XMLHttpRequest` and SSE, with no browser-specific APIs — but the
  demo target is iPhone Safari, which deserves a manual pass before you present.

## Layout

```
beam/
  server.js      Express server: sessions, chunked upload, SSE, reveal
  network.js     Enumerate reachable IPv4 addresses
  test.js        End-to-end test against a real socket
  public/
    index.html   Receive + Send views
    app.js       Client: pairing, live updates, chunked upload
    style.css    Dark, mobile-first
```

No build step. No bundler. No framework. `npm start` and it runs.