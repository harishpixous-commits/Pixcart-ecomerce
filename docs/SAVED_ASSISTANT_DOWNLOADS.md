# Saved assistant downloads

Message and conversation downloads use stored messages and blocks, not a new model call. Supported formats: PDF, XLSX, CSV, Markdown, JSON.

Verified with synthetic records: staff permission, ownership, format-first errors, nearest preceding user question for an assistant message, chronological conversation order, UTC filename timestamp, ASCII filename fallback, site brand, no-store, unchanged saved action status even when the current action row has changed. CSV preserves the reference's distinct table-row formula guard. Excel writes formula-looking strings as text and keeps long numeric strings unrounded.

PDF verification includes rendered table pagination, repeated headers, 2,000-row/14-column caps, visible row omission note, long identifier wrapping, tall rows, inline bold, metric panels, negative-value bar and line charts. DejaVu font files and license are copied from the reference and included in build/publish output.

## Remaining differences and limits

- PDF was visually compared with a locally rendered Python reference fixture. Spacing, chart tick selection, chart legend and row details differ. This is not pixel-perfect PDF acceptance.
- Unequal chart series crash the Python reference renderer. This implementation tolerates them rather than reproducing that failure.
- The workbook writer buffers the document. It is appropriate for saved answer tables, not a substitute for the reference's streaming large exports.
- Indian-script PDF shaping is not accepted. Excel/CSV remain the reference's preferred formats for such names.
- JSON whitespace is not byte-identical to the reference. Saved payload fields and values are preserved.
- General exports and courier booking are separate pending modules. A green test suite is not whole-product or production acceptance.
