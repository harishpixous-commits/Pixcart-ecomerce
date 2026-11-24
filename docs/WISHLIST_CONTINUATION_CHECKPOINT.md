# Wishlist checkpoint and continuation handoff

## Branch custody

- Backend: `instinct/integrated`, `6db557c7f7ccf8dfa7e256fc92227c399b5562cb`.
- Web: this branch, `instinct/web-takeover`. This checkpoint adds the wishlist screen after `4bf30cbc6f45bbd4d77824f12928d8724464041f`.
- Mobile: `instinct/flutter-takeover`, `07f063502e5137223c8ab327ec4514df2a3cc06d`.
- `main` is the live Python/Next.js reference. Do not change, merge into, or deploy it. These parallel branches have not been integrated into one final rebuild branch. Inspect their merge base and preserve each branch's changes before merging.

## Wishlist

Reference: `frontend/src/app/(shop)/wishlist/page.tsx` and `frontend/src/lib/wishlist.tsx` on `origin/main`.

The screen now loads `/api/wishlist` for the signed-in user, filters products against the shared saved-ID set, shows the count, uses the inherited themed dense product grid, and reproduces the empty state with its browse link. A restored guest replace-navigates to `/login?next=/wishlist`. A failed fetch leaves the loader, as in the reference. No new failure policy was invented.

Validation: Angular production build passes using `NG_BUILD_PARALLEL_TS=0 NG_BUILD_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=640 npm run build`. The four wishlist contract tests and nine existing shop contract tests pass together. The grid boundary test replaces the grid with a stub; it is not a product tile integration test.

Actual Chrome images of the full Angular app were inspected at 390x844 and 1366x900, with synthetic empty and populated responses, using the real inherited classic theme tile. Text, count, empty action, product price/rating/heart and phone tabs are visible. The synthetic product intentionally has no image. These are local visual checks, not Next.js screenshot comparisons. Other themes, heart persistence, rapid account switches, 768px and browser e2e remain unverified. The inherited blank brand/logo in the synthetic shell is not evidence of production branding parity.

## Broader state and limits

Backend: latest single full-suite run is 226 passed, zero failed/skipped after shipping storage layering. Actual registered method/path inventory has 429 Python declarations and 431 .NET method endpoints, zero unmatched candidates and zero normalized duplicates. This means presence only, not all behavior/JSON/permissions parity.

Recent backend checkpoints include saved assistant downloads, scoped exports and bulk ZIP, and courier booking. See `docs/EXPORT_PARITY_CHECKPOINT.md` and `docs/SHIPPING_PARITY_CHECKPOINT.md` on the backend branch. Courier remote creation happens before local commit, as in Python, so later failure may leave remote state while local state rolls back. No compensation policy was invented. PDF output is not reference pixel-identical; exported XLSX columns can clip visible IDs/dates even though values remain intact. Scale/disconnect/collation differential work remains.

Web has many placeholder screens. Earlier verified slices were categories, bestsellers, new releases and contact. Wishlist is the next slice, not a full storefront implementation. Shared services/theme components are inherited and need independent source and visual verification. Flutter has a category screen using the real API; other destinations and seller/partner flows remain incomplete. Earlier analyze/core/customer and release-web checks are not Android/iOS acceptance.

Remaining required work includes exact screen/function/theme parity, backend contract differential checks, reference e2e, per-route screenshot comparison at the required widths, IIS packaging/install, data migration and the five requested flow videos. Do not report fully complete before those checks.

All subsequent provider work was synthetic/mock-only. There were three earlier failed Razorpay requests during the rebuild; do not describe the whole history as never-live. No production DB writes, real courier booking, paid provider use, deployment or live-site changes are authorized by this handoff.

Before continuing, read the original project HANDOFF/PORTING_GUIDE/IIS docs, recover the last code from all three branches, build/test the actual combined result, and preserve existing work. Keep code changes on authorized rebuild branches. The owner requested a pause while handing the remaining work back to Claude.
