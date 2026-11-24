# Export parity checkpoint

Implemented admin and seller lists, filter lookups, per-export CSV/XLSX/PDF downloads, and admin bulk ZIP downloads. Definitions come from the Python reference, including 12 admin and 7 seller exports. Data reads use a separate forward reader; XLSX and ZIP output use temporary disk files deleted on close.

Verification includes 57 format requests across all scope definitions, nonempty examples for each non-TCS row plan, nonempty TCS values, selected-column ordering, seller scoping, literal wildcard search, IST date boundaries, permissions, formula guards, no-store/nosniff, rate limits, audit rollback, and ordered bulk files plus manifest. Full suite: 225 passed, zero failed/skipped at this checkpoint. This is not whole-product acceptance.

## Limits still open

- Large XLSX writer has a synthetic 100,001-row test, not a million-row memory measurement. Database row-cap behavior and long-running disconnect cleanup need dedicated stress evidence.
- PDF tables use the local renderer described in SAVED_ASSISTANT_DOWNLOADS.md. Visual spacing and chart details are not pixel-identical to Python.
- XLSX source-style header widths can clip long package identifiers, phone values, dates and About labels. Original cell values remain intact. A rendered nonempty export was checked; this source behavior was not silently changed.
- TCS uses the existing report calculation. Its own tests cover returns and odd tax splits; export transport adds a nonempty positive example, not a second full accounting acceptance.
- General export CSV guard intentionally differs from saved assistant CSV guard, matching the separate Python paths.
- Bulk manifest values are encoded through the general formula-safe CSV encoder, stricter than the reference's raw CSV manifest writer.
- Bulk accepts documented JSON `from`/`to` and internal `date_from`/`date_to` aliases. Conflicting aliases in one body have not been differentially accepted.
- SQL collation behavior follows the existing MySQL schema. Full PostgreSQL/MySQL case and Unicode differential evidence remains open.
- Courier booking, assistant file tool registration, broad UI parity and production acceptance are separate pending work.
