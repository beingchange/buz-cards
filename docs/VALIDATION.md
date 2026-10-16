# Validation record

Checked October 15, 2026 in a Linux container (2 CPU cores, Node 22.22, headless Chromium 141 via Playwright 1.56). Not run on the owner's Windows PC or on physical phones — see "Not checked".

## Automated

| Check | Result |
| --- | --- |
| `npm run typecheck` (server + web) | passes |
| `npm test` — 28 tests | passes |
| `npm run test:e2e` — 3 scenarios × phone (Pixel 7 emulation) and desktop | 6/6 pass |
| `npm run build` | passes (app ≈ 305 KB JS, 93 KB gzipped) |

What the tests cover:
- **Extraction** (14): columns (name beside address), stacked company/name/title, credentials split, ZIP+4 / licence numbers not phones, phone labels before/after numbers, no country-code invention, e-mail disagreement flagged with alternative, disagreement resolved only by evidence elsewhere on the card, e-mail/website look-alike cross-check, card back produces no invented name, vCard/MECARD QR, city-line rules, reading consensus (spacing, ligatures, dictionary).
- **Exports** (3): the generated `.xlsx` is read back and every cell is compared with the stored value — text cells only, no formulas, `+` and leading zeros kept, Unicode, a formula-like company name, 3000-character notes, multiple e-mails/phones; vCard escaping, 75-octet folding without splitting UTF-8, all e-mails/phones present.
- **Recognition** (3): iPhone-style HEIC photo with a QR vCard; EXIF-rotated photo; upside-down card; non-image rejected with a specific message.
- **Server workflow** (8, real OCR on fictional photo fixtures): idempotent upload retry (same item, no duplicate), invalid file reported, 5th file over a 4-file limit rejected with a reason, every image accounted for, item interrupted mid-processing recovered without a duplicate contact, manual correction kept through *Re-read unsaved*, stale edit refused (409), save-many, Excel export compared cell-by-cell with stored contacts, vCard count, duplicate warning on re-scan, discard keeps saved contacts, backup → delete → restore brings the contact and its image back, malformed backups rejected, legacy JSON import.
- **Browser** (phone and desktop layouts): gallery batch with one invalid file → progress → review with evidence highlight → edit (warning cleared, "Edited") → *Save & next* ×2 → Contacts → Export summary → downloaded `.xlsx` contains the e-mails; plain-HTTP non-localhost origin (`isSecureContext === false`, no `crypto.randomUUID`) with wrong and right access code and a camera-input single scan; a photo chosen while the computer is unreachable, then a page reload, is uploaded and read afterwards.

Bugs found by these checks and fixed: nested database transaction broke restore; *Save* right after an edit raced the autosave (false "changed elsewhere"); batch screen said "all read" while photos were still uploading; uploads did not resume after a reload; OpenCV loading hung under some module loaders.

## Accuracy

See [EVALUATION.md](EVALUATION.md): 28 real (WhatsApp-compressed) card photos and 12 synthetic photos, first automatic result.

## Not checked

- Physical iPhone / Android: camera and gallery pickers, real HEIC from an iPhone, `.vcf` import into Contacts, install-to-home-screen, behaviour when the phone locks mid-upload.
- The owner's Windows PC (`start-local.cmd`, `start-phone.cmd`, firewall prompt, speed on that CPU). CI is configured for Windows + Node 22/24 but was not run from here.
- HTTPS with a self-signed or mkcert certificate on a phone.
- Live LinkedIn search with a real Brave API key (code path and error handling exist; no key was used).
- 25-image batches of full-resolution phone photos (largest batch tested: 4 photos; per-card time is measured, ~4–6 s on 2 cores).
