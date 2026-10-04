# Beam verification

Date: October 3, 2026
Source: `287fe85a22db5c179c11c681b2b190e7f04b317a`

## Real browser flow

Tested unmodified source in Chromium with desktop and 390px mobile-width pages, both on the same computer. The receiver created a session and QR. Opening its paired sender URL, choosing a file through the file input, and completing the transfer produced a real file in the receiver's destination folder. The original and saved bytes matched. Manual-code entry accepted a valid lower-case code and showed an error for an unknown code.

This is browser-to-server evidence, not a physical-phone, camera-scan, Safari, Firefox, LAN, or public-network test. The hosted-mode labels in the screenshots are intentional. The demo server was loopback; its displayed URL is not a public deployment.

## Socket tests

`npm test`: 52 passed, 2 failed in the test environment. Passing checks cover session creation, exact QR URLs, chunked uploads, out-of-order chunks, idempotent repeated chunks, byte-exact completion, receiver events, downloadable files, thumbnail restrictions, filename traversal cleanup, upload bounds, incomplete completion, and the web shell.

Two checks require a usable LAN interface. The environment had none, so only the configured public test URL was available. This result does not validate LAN discovery on the user's computer. It is not presented as a clean all-tests pass.

## Limits

- No physical phone, cross-network, Safari or Firefox test in this pass.
- Local folder reveal is OS-dependent and has not been verified on Windows or macOS here.
- An active pairing code permits a sender to upload. There is no receiver approval or strong account authentication.
- LAN traffic uses HTTP. A public HTTPS route depends on the hosting/tunnel setup.
- Hosted transfers land on the server, not automatically in the remote laptop's Downloads folder.
- The sender file picker remains visible after an invalid-code response, although the backend refuses unknown codes. This is an interface rough edge, not a successful pairing.
- Existing README timing claims were not reproduced. Do not treat them as phone/Wi-Fi measurements.

## Judging sources

Dublin HacX overview: https://dublin-hacx.devpost.com/

Rules: https://dublin-hacx.devpost.com/rules

General rubric: https://docs.google.com/document/d/1rf9uypeq4cykfowBjw9ZPpR3PKHWEwAWsonrv7xNCQw/edit?tab=t.u0qswclwxm83

The Devpost page showed a 10 PM PDT deadline while organizer schedule context says 8 PM. The earlier time remains the safer preparation target. No statement of team eligibility, authorship, or code creation time is made by this verification.
