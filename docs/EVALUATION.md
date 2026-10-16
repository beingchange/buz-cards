# Evaluation

The only accuracy numbers that matter are measured on **real card photos**, on the **first automatic result before any manual correction**. Synthetic test cards are used for regression tests only.

## How to measure on your own cards

1. Put original card photos (straight from the phone camera, not forwarded through a messenger) in `private-eval/` (git-ignored).
2. Write `private-eval/ground-truth.json`, one entry per photo, typed by a person from the physical card:

```json
[
  {
    "file": "IMG_0001.jpg",
    "name": "Jane Example",
    "company": ["Example Labs", "Example Labs Inc."],
    "title": "Director of Sales",
    "emails": ["jane@example-labs.com"],
    "phones": ["+1 (555) 010-2030", "555.010.4000"],
    "websites": ["www.example-labs.com"],
    "address": "1 Main St, Springfield, IL 62701",
    "illegible": []
  }
]
```

Use a list for fields with more than one acceptable reading (e.g. logo vs. legal name). Leave a field out if the card does not print it. `"noName": true` marks a card with no person (e.g. a card back). `illegible` lists fields printed but unreadable in that photo (excluded from recall).

3. Run `npm run eval`. The report (`private-eval/reports/eval-*.md`) lists every miss with the full recognized text. Comparisons: e-mail case-insensitive; phones by digits + extension (formatting ignored, country prefix as printed); names/titles/companies exact except case, spacing and spaces around `-`/`/`/`|`; address ignoring punctuation.

`npm run eval:synthetic` runs the same report on the 12 fictional photo-style fixtures (clutter backgrounds, perspective, EXIF rotation, upside-down, white-on-red panel, low contrast, small print).

## Results (October 2026)

### Real cards — development set, 28 photos

The owner's photos: 26 different cards + 2 repeat photos (one card back twice, one card twice), US exhibition cards (energy/building industry). **All were forwarded through WhatsApp: 817 × 634 px, ~30 KB JPEGs** — far below a phone camera's resolution, so small print has only a few pixels. Includes: white text on a red card, stacked names and logos, portrait cards, a card rotated ~55° and cut off by the photo edge, card backs with service lists, handwriting, credentials after names, `.bank` / `.coop` / `.energy` domains, QR codes.

**Caveat: these 28 photos were used to develop the layout rules.** The numbers below are therefore optimistic for new cards. A held-out set of new photos is needed for an unbiased figure (see "Next measurement").

| Measure (first automatic result) | Tesseract-based previous version¹ | Buz Cards 2 |
| --- | --- | --- |
| E-mail precision | – | **88.0 %** (22/25) |
| E-mail recall (legible) | – | **88.0 %** (22/25) |
| E-mails wrong **and not flagged** | – | **0** |
| Phone precision / recall | – | **95.6 %** (43/45) / **97.7 %** (43/44) |
| Phones wrong and not flagged | – | **0** |
| Website recall | – | 100 % (19/19) |
| Name exact | – | **96.2 %** (25/26) |
| Company exact (+ partial) | – | 87.0 % (20/23) (+2 partial) |
| Position exact | – | 100 % (25/25) |
| Address exact | – | 83.3 % (10/12) |
| Cards with every field correct | – | **78.6 %** (22/28) |
| Cards needing any correction | – | 21.4 % (6/28) |
| Card outline found automatically | – | 92.9 % (26/28) |
| Median time per card (2-core cloud VM, CPU) | – | ~4 s |

¹ The previous version was not run on this set; it was reported by its owner to miss names/e-mails frequently on real cards.

Progress during development on the same 28 photos (first pass → final): e-mail recall 84 % → 88 % with every remaining wrong e-mail flagged; names 62 % → 96 %; companies 39 % → 87 %; positions 72 % → 100 %; all-correct cards 3 → 22.

**Remaining errors (all 6 cards), and what the user sees:**

| Card | Problem | Flagged? |
| --- | --- | --- |
| e-mail on a small logo card | domain read with `l` where the card prints `1` (1 / l look-alike); logo text not readable | Yes — the other model's reading is offered as a one-tap fix |
| tiny-print card (~8 px letters) | e-mail misread; one phone digit; an apostrophe in the first name missed; address unreadable | E-mail and phones flagged "print is very small"; the name is **not** flagged |
| e-mail in small grey print | `…lot.com` vs printed `…iot.com` | Yes — e-mail and website flagged as differing only by look-alike letters |
| company line with ™ | a `(NameTM)` suffix appended to the company | Yes |
| card cut off by the photo edge | partial website (first letters cut off); company garbled | Website flagged as touching the edge |
| portrait card | city-only address "New York" not recognised as an address | No (field left empty, not wrong) |

Release targets from the brief (≥ 98 % e-mail precision, ≥ 95 % recall, ≥ 95 % names, ≥ 95 % phones, ≥ 90 % cards without manual crop) are **not demonstrated**: e-mail precision/recall is 88 % on this low-resolution set, and the sample is small and was used for development. No manual crop/rescan was needed for any of the 28 photos to obtain the results above, but 6 of 28 cards still need a field corrected.

### Synthetic photo fixtures (fictional, public) — 12 photos

E-mail, phone, website, name, company and position: 100 %. Address 11/12 (`FriedrichstraBe` instead of `Friedrichstraße`; flagged "B may be ß"). 11/12 cards fully correct. These are **not** evidence of real-card accuracy.

## Next measurement (recommended)

1. Photograph 30–50 **new** cards with the phone camera (original files, not via WhatsApp).
2. Add their ground truth, run `npm run eval` once **without changing the code**, and record the numbers here as the held-out result.
3. Then fix, re-measure, and keep the held-out numbers separate from the development numbers.
