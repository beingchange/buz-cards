# Architecture

Buz Cards is one Node.js process on the user's computer serving a React web app and a JSON API. Phones and the computer's own browser are thin clients of that process.

```
src/                     React web app (phone-first, works over plain HTTP on the LAN)
  outbox.ts              IndexedDB upload queue: photos survive refresh / lost Wi-Fi until the server confirms
  screens/               Scan, Batch, Review (editor), Contacts, Settings, Access
server/
  index.ts               start HTTP (+ optional HTTPS), print LAN URLs and access code
  app.ts                 Express API, access-code check, static app, error mapping
  db.ts                  node:sqlite database, versioned migrations (PRAGMA user_version)
  contacts.ts            contact model operations: apply extraction, keep manual edits, duplicates, merge
  batches.ts             persistent queue: idempotent uploads, sequential processing, recovery, discard
  cards.ts               original/processed images on disk + OCR results
  exports.ts             .xlsx (ExcelJS) and vCard 3.0
  backup.ts              .zip backup / validated, previewed restore / legacy JSON import
  linkedin.ts            optional Brave Search API; candidates only
  recognition/           image → text lines (replaceable)
    image.ts             decode JPEG/PNG/WebP/HEIC, EXIF orientation, card outline, perspective warp
    paddle.ts            PaddleOCR detection / angle / recognition on ONNX Runtime (CPU)
    consensus.ts         merge two models' readings (spacing union, dictionary, ligature recovery)
    engine.ts            pipeline + orientation + deskew + QR codes; returns lines with boxes + all readings
    worker.ts, pool.ts   runs the engine in a worker thread with a timeout
  extraction/            text lines → contact fields (replaceable)
    fields.ts            layout rules, voting across readings, evidence, field states
    patterns.ts          e-mail/phone/web/address/title/credential patterns and normalisers
shared/types.ts          data model shared by server and app
scripts/eval.ts          accuracy evaluation against human-verified ground truth
```

## Recognition pipeline

1. **Decode** (`image.ts`): magic-byte sniffing (the browser's MIME type is not trusted), EXIF orientation applied, HEIC via `heic-decode` (WebAssembly libheif). Large photos are capped at 4800 px; no early downscaling below that.
2. **Card outline**: OpenCV (WebAssembly) proposes quadrilaterals from edges, colour difference to the background and brightness; they are scored by edge strength, rectangularity and aspect ratio. A candidate that encloses the best one (e.g. the whole card around its red panel) is preferred. The card is perspective-corrected at full resolution.
3. **Outline check**: if much of the photo's text lies outside the outline *and* the crop yields almost no contact details (logo frame, card cut off by the photo edge), the whole photo is read too and the reading with more contact evidence wins. Background clutter alone never triggers this.
4. **Orientation**: dominant text angle from detected boxes (arbitrary-angle deskew), sideways detection, then 180° check with the angle classifier confirmed by recognition confidence.
5. **Text detection**: PP-OCRv5 mobile detector, twice — on the image and on a contrast-equalised version (faint grey, coloured panels, light-on-dark). Boxes keep their coordinates.
6. **Column split**: character positions from the recognizer's CTC output split a line wherever a gap is wider than ~2 character heights (name and street address on the same row become separate lines).
7. **Two independent readings**: PP-OCRv5 multilingual recognizer and the English PP-OCRv4 recognizer read every line. When they disagree, a third reading (upscaled crop) is taken. `consensus.ts` picks a reading by votes, Latin-script plausibility and English-word evidence, recovers letters swallowed by fi/fl ligatures, merges spacing; a line is *disputed* when no two independent models agree.
8. **QR codes**: jsQR on the card and the whole photo (vCard, MECARD, mailto, tel, URLs).

Output: lines with text, box, confidence, every model's reading, disputed flag; QR payloads; card scale (so extraction knows how many photo pixels the text had).

## Field extraction

`extraction/fields.ts` turns lines into fields without guessing:

- **E-mails, websites, phones** are found in *every* reading of a line and voted on. A disagreement is resolved only by evidence printed elsewhere on the card (whole-word matches, look-alike characters tolerated); otherwise the field is `needs_review` with the alternatives offered. An e-mail domain and website that differ only by l/1/i or 0/o are both flagged.
- **Phones** keep the printed format; `normalized` is digits (+ leading `+` if printed). No country code is ever added. Labels before or after the number (`T`, `Mob`, `(M2)`, `(O)`, `Direct`, …). ZIP+4 codes, licence numbers (`#…`) and address digits are not phones.
- **Address** blocks are built from address-scored lines and their vertical/row neighbours.
- **Name / title / company** use word lists (titles, company suffixes, business vocabulary), letter height, position next to the title, match with the e-mail local part (strong), match with the web domain (company; acronyms like GBC ↔ greenbanyanconsulting), stacked-line joining (logos, two-line names) and same-row joining. Credentials (`PE, CEM`, `MBA`) are moved out of the name into their own field. Service lists (`A | B | C`, bullets) never become names or companies.
- **Field states**: `extracted`, `needs_review` (with specific reasons), `not_found` (no claim that it is absent from the card), `user_corrected`, `enriched`; `failed` lives on the batch item. Small print in the original photo (< ~22 px text boxes with lower confidence) is flagged.

Every field keeps `machineValue`, `source` (ocr/qr/user/enrichment/import), `lineIds` and the evidence `box`.

## Data model and persistence

SQLite (`node:sqlite`, no native build step) in WAL mode:

- `contacts` — id, state (`draft`/`saved`/`skipped`), JSON document (`shared/types.ts` `Contact`), search text, revision (optimistic concurrency: a stale write gets HTTP 409, never silently overwrites).
- `cards` — original file (kept byte-for-byte), processed image, OCR JSON, engine version, side (front/back).
- `batches`, `batch_items` — job state; `(batch_id, client_key)` is unique so a retried upload returns the existing item. The draft contact id is assigned at upload, so re-processing updates the same draft and never creates a duplicate.
- On start, items left in `processing` go back to `queued`.

Manual corrections: any changed field becomes `user_corrected`; re-reading (rotate, crop, *Re-read unsaved*, engine upgrade) updates only machine fields and remembers which machine values the user deleted.

## Replacing a component

- **Recognition**: anything that returns `OcrPage` (`engine.ts`) can replace it. To add a vision-language model or a cloud provider, implement `recognizeCard(buffer) → { page, cardImage }` (or post-process `page.lines`) and select it in `recognition/worker.ts`. Keep the readings/boxes so evidence and disputes still work.
- **Extraction**: `extractFields({ lines, qr, width, height, scale })` is pure; `scripts/eval.ts` measures any change.
- Bump `ENGINE_VERSION` / `EXTRACTOR_VERSION` when behaviour changes; the eval cache and stored drafts are keyed on it.

## Security notes

- Default bind is `127.0.0.1`. LAN mode requires a 6-digit access code (HttpOnly cookie); loopback is trusted.
- No analytics, no telemetry, no outbound requests except the optional LinkedIn search.
- Text on cards is treated as data only; there is no language model that could follow instructions printed on a card.
- API keys are read from `.env` on the server; not sent to clients, not logged, not backed up.
