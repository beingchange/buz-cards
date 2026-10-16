# Limitations and untested areas

Honest list. If something here matters to you, test it on your own cards first.

## Recognition

- **Measured on 28 real card photos only**, and those same photos were used while developing the rules (see EVALUATION.md). Expect lower numbers on new, different cards until a held-out set is measured.
- **Low-resolution photos** (e.g. images forwarded through WhatsApp, ~800 px wide) lose small print. The app flags very small print, but cannot recover letters that are not in the pixels. Use the original camera photo.
- **Look-alike characters** (l / 1 / I, 0 / O, rn / m, ß / B) are the main remaining error source in e-mails and domains. They are flagged, never silently "fixed", unless another line on the same card spells the word.
- **Stylised logos** (custom lettering, letters drawn as shapes) are often not read as text; the company may then come from a tagline or stay empty. Company is set only from printed text or a QR code, never guessed from the e-mail domain.
- **Handwriting** on cards is not read reliably and is usually ignored.
- **Languages**: English layouts are the priority. The primary model reads Latin-script diacritics (é, ü, ñ) and many other scripts, but field rules (titles, addresses, company suffixes) are English-centric. Non-Latin cards are not evaluated.
- **Addresses** are kept as printed text (joined lines); they are not parsed into street/city/postcode.
- **One card per photo.** A photo with several cards is read as one card.
- **Card backs** must be attached to their contact from the review screen; gallery photos are never paired automatically.
- **Speed**: about 3–6 s per card on a 2-core cloud machine; a 25-card batch ≈ 2–3 minutes. Slower on old laptops. A cluttered background with lots of text (e.g. a keyboard) adds time.

## Platforms

- Developed and tested on Linux (Node 22) with headless Chromium in phone (390×844) and desktop layouts.
- **Not tested on a physical iPhone or Android phone**: camera chooser behaviour, gallery multi-select limits, .vcf import into the system address book, HEIC files produced by a real iPhone (a synthetic HEIC is tested), and install-to-home-screen. Please report results.
- **Not tested on Windows by the author's automated runs** (CI is configured for Windows; the user's Windows machine was not used to run it). `start-local.cmd` / `start-phone.cmd` are simple wrappers around `npm` commands.
- Network: phone access depends on your Wi-Fi allowing device-to-device traffic and on the Windows firewall prompt being accepted.

## App behaviour

- No background notifications for follow-ups; due follow-ups are shown in the app.
- No automatic sync between installations. One computer = one contact database. Move data with backup/restore.
- No CSV export or CRM integration yet.
- LinkedIn search requires an optional third-party API key and internet; results can be incomplete or stale and must be confirmed by you.
- Plain HTTP on the LAN is unencrypted; the access code is sent in clear text over it. Use HTTPS on networks you do not trust.
- Deleting a contact keeps its card image files on disk until a future cleanup feature (backups include them).
