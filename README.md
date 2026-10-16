# Buz Cards

Scan business cards from your phone, check the few details the reader is unsure about, and export a clean Excel file or phone contacts. Card photos are read **on your own computer**. No account, no cloud OCR, no subscription.

- **Scan** one card with the camera, or pick **1–25 photos** from your gallery (more are split into batches automatically: 30 photos = 25 + 5).
- **Review** each card next to its photo. Tap a field to see where on the card it was read. Uncertain fields are marked **Check** with the exact reason ("the two recognition models read this differently", "print is very small in this photo", "e-mail domain and website differ only by look-alike letters") and one-tap alternatives. Nothing is invented.
- **Keep** contacts with event, tags, notes, status and follow-up date. Search, filter, find duplicates, merge.
- **Export** a real `.xlsx` (one row per contact, every e-mail and phone kept), a `.vcf` for iPhone/Android contacts, and a full `.zip` backup.

> Accuracy is measured, not assumed. See [docs/EVALUATION.md](docs/EVALUATION.md) for results on real cards, including the failures.

## How it works

```
 Phone / computer browser ──Wi-Fi──▶  Buz Cards server (your computer)
   take or pick photos                  ├─ stores originals (data/images)
   review & edit                        ├─ reads cards: card outline → straighten → PaddleOCR (2 models) → layout rules
   export                               ├─ one SQLite database (data/buz-cards.sqlite) shared by all your devices
                                        └─ Excel / vCard / backup files
```

| | Where it happens |
| --- | --- |
| **Recognition** | On the computer running Buz Cards (CPU, no GPU needed). ~3–6 s per card on a typical laptop. |
| **Storage** | `data/` folder next to the app on that computer (change with `BUZ_DATA_DIR`). Phone and computer see the same contacts. |
| **On the phone** | Nothing permanent. Photos waiting to upload are kept in the browser (IndexedDB) until the computer confirms it has them. |
| **Internet** | Only for installing, and for the *optional* LinkedIn search API. Card photos and contacts are never uploaded anywhere. |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install (Windows, macOS, Linux)

Requirements: **Node.js 22.18+ or 24 LTS** ([nodejs.org](https://nodejs.org)). About 350 MB of disk for dependencies (the two OCR models are ~25 MB of that). No Python, no GPU, no separate model download: the models come from npm packages.

```sh
npm ci          # installs dependencies and the OCR models
npm run build   # builds the web app
npm start       # http://localhost:4173
```

On Windows you can double-click **`start-local.cmd`** (this computer only) or **`start-phone.cmd`** (also reachable from your phone). Both install and build on first run.

First start takes ~10 s while the recognition models load.

## Use it on your phone (same Wi-Fi)

1. Start with `start-phone.cmd` (or `HOST=0.0.0.0 npm start`). The window prints the address and a **6-digit access code**, e.g. `http://192.168.1.20:4173`.
2. On the phone, connect to the **same Wi-Fi**, open that address, enter the code (asked once per browser).
3. Windows may ask to allow Node.js through the firewall: allow it for **private networks**. Guest/hotel Wi-Fi often blocks phone-to-computer traffic; use a home/office network or your phone's hotspot.

The access code keeps other people on the same Wi-Fi out of your contacts. Requests from the computer itself never need it. Set your own with `BUZ_ACCESS_CODE` or disable it with `BUZ_REQUIRE_CODE=0` (not recommended).

**At an expo without your computer:** just take photos with the phone camera. Back home, use **Choose from gallery** to read them in batches.

### Plain HTTP vs HTTPS

Over plain `http://192.168…` everything works (camera, gallery, review, exports), because the app avoids secure-context-only browser features. What plain HTTP does **not** give you: transport encryption, "Add to Home Screen" as an installed app, and an offline app shell. For those, run with HTTPS:

```sh
HTTPS=1 npm start        # also serves https://<computer-ip>:4443
```

This creates a self-signed certificate in `data/tls/`. Your phone will warn once; accept it (iOS: you may need to install/trust the certificate under Settings → General → About → Certificate Trust Settings). For a warning-free setup, create a trusted local certificate with [mkcert](https://github.com/FiloSottile/mkcert) and set `TLS_CERT` / `TLS_KEY` to its files. Remote access from outside your network (e.g. via Tailscale) is possible but not set up by this project.

Even when installed, the app needs the computer to read cards; offline you can still pick photos and they upload when the computer is reachable again.

## Everyday workflow

**One card:** Scan → *Take a photo* → it is read on the computer (a few seconds) → review screen opens → fix anything marked **Check** → *Save contact*.

**A stack of cards:** Scan → *Choose from gallery* → select up to 25 (or more: they are split) → optional event and tags → *Read*. Photos upload one by one; the computer reads them in order. You can lock the phone or close the page: processing continues on the computer and everything is waiting when you come back. In the batch list:
- *Review next card* walks you through drafts (*Save contact & next*).
- Tick cards that look right and *Save selected* (you are told if any still have flagged fields).
- *Retry* a failed photo, *Re-read unsaved* after an update (your edits are kept), *Pause/Resume*, *Discard unsaved* (saved contacts are never deleted).

On the review screen you can rotate or crop the photo and read it again (your manual edits are kept), switch to the original photo, add the **back of the card**, merge with a duplicate, and attach a LinkedIn profile.

## Exports

- **Excel (.xlsx)**: all saved contacts, the current filtered view, or a selection. The sheet shows how many have/lack e-mail and phone before you download. Every value is a text cell exactly as stored (leading `+` and zeros kept, nothing evaluated as a formula). Primary e-mail/phone have their own columns; others are listed one per line as `Type: value`. A *Review state* column marks unverified fields. Unsaved drafts are excluded unless you tick the option, and are then marked `DRAFT`.
- **Phone contacts (.vcf, vCard 3.0)**: open the file on the phone. iPhone: open the .vcf → *Add All Contacts* (or Share → Contacts). Android: open from Downloads → Contacts, or Contacts → *Fix & manage → Import from file*. The phone's own import step adds them; Buz Cards cannot write to the address book directly.
- **Backup (.zip)**: Settings → *Download backup*: contacts (saved and drafts), card photos, recognition results, unfinished batches. Restore shows a preview first and never deletes existing contacts; for contacts that exist in both you choose keep / replace / keep both. Backups from the earlier browser-only Buz Cards (`.json`) can be imported the same way.

Keep backups somewhere other than the computer running Buz Cards. Your contacts exist only in its `data/` folder.

## LinkedIn

- A LinkedIn URL printed on the card or stored in its QR code is extracted automatically.
- Otherwise the contact page offers **Search on LinkedIn** / **Web search** links (free, opens in your browser).
- Optional: put a [Brave Search API](https://brave.com/search/api/) key in `.env` as `BRAVE_SEARCH_API_KEY`. *Find profile* then lists candidate `linkedin.com/in/…` pages with their snippet; you open one, then tap *This is them*. Nothing is confirmed automatically, no LinkedIn login or scraping is used, and a failed search never blocks saving or exporting. The search sends the person's name and company to Brave; their pricing/quotas apply.

## Configuration (`.env`)

Copy `.env.example` to `.env`. All optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | `0.0.0.0` to allow phones on your network |
| `PORT` / `HTTPS_PORT` | `4173` / `4443` | ports |
| `HTTPS` | off | `1` to also serve HTTPS |
| `TLS_CERT`, `TLS_KEY` | – | your own certificate (e.g. mkcert) |
| `BUZ_DATA_DIR` | `./data` | where the database and photos live |
| `BUZ_ACCESS_CODE` | random, saved | phone access code |
| `BUZ_MAX_FILES` / `BUZ_MAX_FILE_MB` / `BUZ_MAX_BATCH_MB` | 25 / 25 / 150 | batch limits |
| `BRAVE_SEARCH_API_KEY` | – | optional LinkedIn suggestions |
| `BUZ_MODEL_DIR` | – | load OCR models from a folder instead of npm packages |

Keys stay on the server: they are never sent to the browser, logged, or included in backups.

## Updating

```sh
git pull && npm ci && npm run build && npm start
```

Your `data/` folder is not touched by updates. The database schema is versioned and migrated forward on start; a newer database is never opened by an older app. Cards already saved are not re-read; use *Re-read unsaved* in a batch to apply a better recognition engine to drafts (manual edits are kept). The browser never caches the app shell, so phones pick up the new version on the next load.

## Accuracy, limits and testing

- [docs/EVALUATION.md](docs/EVALUATION.md) – how accuracy is measured on your own cards (`npm run eval`), current results, failure cases.
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) – what does not work (yet), and what was not tested.
- `npm test` – unit, export-fidelity and end-to-end server tests (uses fictional synthetic cards only).
- `npm run test:e2e` – browser tests in phone and desktop layouts.

## License

MIT — see [LICENSE](LICENSE). Third-party components and model licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
