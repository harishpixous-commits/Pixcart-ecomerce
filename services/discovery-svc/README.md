# discovery-svc
FR-CUS-009 (lexical core) + FR-CUS-010 (semantic) — the provable half of search.

- query.ts — sanitisation (control chars + query metacharacters), banned/regulated-term
  policy message, constraint extraction (price under/above/between with k/lakh/₹/comma
  notations, star rating) including **Tanglish** postpositions ("5k kku keela" = below 5k),
  graceful fallback (unrecognised text, incl. Tamil script, is preserved for the lexical and
  vector layers), inverted-range rejection, and attribute-schema validation that DROPS
  constraints a category does not declare rather than applying them blindly.
- fusion.ts — reciprocal-rank fusion (score = Σ weight/(K+rank), K=60) with per-category
  configurable weights; the approved-only index filter applied AFTER fusion so a stale index
  can never surface a non-LIVE / out-of-stock / unserviceable listing (fails closed on
  unknown ids); sponsored blending capped at 2 of the top 10, every one labelled "Sponsored".

NOT here: the OpenSearch index and the vector store — they cannot run in this sandbox, so
they are adapters at the edge that supply the two ranked id lists this module fuses.
20/20 vitest.
