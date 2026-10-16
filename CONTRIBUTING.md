# Contributing

1. `npm ci`, then `npm run typecheck`, `npm test` and `npm run build` must pass.
2. Recognition or extraction changes: run `npm run eval:synthetic` **and** `npm run eval` on your own private card photos (see docs/EVALUATION.md). Report both, including what got worse. Passing synthetic tests is not evidence of real-card accuracy.
3. Never commit photos of real people's cards, real contact data, or ground-truth files made from them. `private-eval/` is git-ignored for this reason. Public fixtures must be fictional (`tests/fixtures/synthetic`).
4. Do not hard-code names, domains, companies or coordinates from specific cards. Fixes must be general rules with a test.
5. Bump `ENGINE_VERSION` (recognition) or `EXTRACTOR_VERSION` (fields) when behaviour changes.
6. Database changes: add a numbered migration in `server/db.ts`; never drop or rewrite user data.
