# Beam
## Tagline
Scan a code. Send a file. Skip the account.

## Inspiration
Getting a file from a phone onto a laptop should not mean emailing yourself, uploading to a drive, or installing an app on both devices. Beam takes the simple part of that experience, pairing and sending, and makes it available through a browser.

## What it does
Beam turns a computer into a file receiver. Open the receive screen, then scan its QR code from another device or type its six-character pairing code in the Send tab. Choose a file and watch it arrive, with live progress and a completed-file card. Images get a preview. Completed files can be downloaded from the receiving screen.

When the server runs on your own computer, files are saved to its Downloads/Beam folder. When the server is hosted elsewhere, they are stored on that server and can be downloaded. The interface explains the difference. There is no sender account or sender app installation.

## How we built it
The backend uses Node.js and Express. The frontend is HTML, CSS, and JavaScript without a build step. QR codes carry a session URL, with a short code as a camera-free fallback. The server lists available network interfaces so the receiver can choose an address another device can reach.

Uploads use 5 MB chunks with four requests in flight. Chunks are written at their offsets, so out-of-order arrival does not change the result. Retrying a chunk does not add to the received-byte count. Server-Sent Events update the receiver as bytes arrive; the frontend also polls session state as a fallback.

The receiver checks upload bounds and refuses incomplete completion requests. Filenames are reduced to safe basenames, and SVG image previews are refused. Sessions expire after ten minutes. These are practical safeguards, not a claim of production-grade security: anyone who knows an active pairing code can send a file.

## Challenges we addressed
A QR code is only useful if the address inside it is reachable. Local and hosted modes have different routing and storage behavior, so Beam distinguishes them instead of pretending every transfer goes directly to the user's laptop. Another challenge was tracking progress correctly when chunks arrive out of order or are retried. Writing chunks at explicit offsets and counting received ranges keeps progress and completion tied to the actual file.

## Accomplishments
A real browser upload reached the receiver and matched the original bytes on disk. The socket test suite also verified out-of-order chunks, repeated chunks, live events, completed-file downloads, thumbnails, filename cleanup, and error responses. A small mobile-width send screen and a camera-free code entry keep the main interaction short.

## What we learned
The transfer is only part of the experience. Pairing, choosing a reachable address, and being clear about where files are saved matter just as much. A small number of explicit states, waiting, sending, saved, and error, makes the interface easier to explain and test.

## What's next
Test the complete flow on physical phones and across Safari and Firefox. Add receiver approval, abuse controls, and clearer session lifecycle controls before treating the app as ready for open networks. Improve interrupted-transfer recovery and make hosted retention behavior explicit.

## Built with
JavaScript, Node.js, Express, HTML, CSS, Server-Sent Events, QR codes.

## Rubric evidence
### Technical Execution (20%)
The project has a real server and browser client, chunked uploads, concurrent requests, idempotent offset writes, live progress, downloadable results, and error handling. Byte-exact transfers and edge-case tests support the case for strong technical execution. Physical-device and broader browser validation remain open.
### Innovation & Creativity (15%)
The product angle is a browser-first, account-free sender with a computer-controlled receiver and camera-free pairing fallback. QR file transfer is an existing category; Beam should be judged on its execution and specific workflow, not a claim that it invented file sharing.
### Impact & Usefulness (20%)
The problem is a familiar one: moving a file between devices without relying on a matching ecosystem or an account. Beam reduces the steps for the sender. The audience and scaling case are plausible, not measured adoption or validated demand.
### Completeness & Working Demo (15%)
The core browser-to-server flow works end to end and produces a real saved file. Code pairing, invalid-code feedback, and completed-file download are demonstrable. A browser simulation is not a physical-phone test, and hosted files land on the server rather than automatically on a remote laptop.
### Design & UX (10%)
A consistent receive/send layout, large QR and short code, mobile-width file picker, progress display, and completed-file cards give the product a focused interaction. Desktop and mobile-width layouts have been inspected for readability.
### Presentation (10%)
The pitch follows the actual user journey: problem, pairing, real transfer, result, implementation, and limits. Screenshots and a narrated demo should show the real app rather than mockups presented as live functionality.
### Judge's Preference (10%)
Beam offers a direct, easy-to-understand demo and a clear user problem. The judge's personal connection is theirs to decide. No score is guaranteed.
