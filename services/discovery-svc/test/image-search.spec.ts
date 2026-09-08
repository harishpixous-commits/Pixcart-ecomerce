/**
 * FR-CUS-012 image search. The privacy properties are tested as behaviour rather than as flags:
 * the GPS bytes must be GONE from the buffer, and the embedder must receive the BLURRED image.
 * "EXIF stripped" and "faces blurred before any processing" are claims about bytes and ordering,
 * and only tests about bytes and ordering can check them.
 */
import { describe, expect, it } from 'vitest';
import {
  ingest,
  isDueForPurge,
  isUrlValid,
  MAX_IMAGE_BYTES,
  mayUseForTraining,
  purgeExpired,
  RETENTION_MS,
  searchByImage,
  signedUrl,
  SIGNED_URL_TTL_MS,
  sniffType,
  stripExifJpeg,
  tierFor,
  type Detectors,
  type ProcessedImage,
  type SearchOptions,
  type UploadedImage,
} from '../src/domain/image-search.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);

/**
 * Build a minimal but structurally real JPEG: SOI, an APP1 (EXIF) segment carrying recognisable
 * GPS bytes, a benign APP0, then SOS and scan data.
 */
function jpegWithExifGps(): Uint8Array {
  const exifPayload = [...Buffer.from('Exif\0\0GPSLatitude:11.0168,GPSLongitude:76.9558', 'ascii')];
  const app1Len = exifPayload.length + 2;
  const app0Payload = [...Buffer.from('JFIF\0', 'ascii')];
  const app0Len = app0Payload.length + 2;
  return new Uint8Array([
    0xff, 0xd8,                                       // SOI
    0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...exifPayload,   // APP1 (EXIF + GPS)
    0xff, 0xe0, (app0Len >> 8) & 0xff, app0Len & 0xff, ...app0Payload,   // APP0 (JFIF)
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,          // SOS
    0x12, 0x34, 0x56, 0x78,                                              // scan data
    0xff, 0xd9,                                       // EOI
  ]);
}

const pngBytes = () => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 0,
]);
const webpBytes = () => new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);
const heicBytes = () => new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
]);

const upload = (over: Partial<UploadedImage> = {}): UploadedImage => ({
  uploadId: 'UP-1',
  bytes: jpegWithExifGps(),
  declaredMime: 'image/jpeg',
  uploadedAtMs: NOW,
  sessionId: 'S-1',
  ...over,
});

/** A marker the blurrer prepends, so a test can tell blurred bytes from unblurred ones. */
const BLUR_MARKER = 0xbb;

const detectors = (over: Partial<Detectors> = {}): Detectors => ({
  detectFaces: () => 0,
  blurFaces: (bytes) => new Uint8Array([BLUR_MARKER, ...bytes]),
  detectNsfw: () => false,
  detectProduct: () => ({ categoryId: 'CAT-SAREES', confidence: 0.9, region: { x: 0, y: 0, width: 100, height: 100 } }),
  embed: () => [1, 0, 0, 0],
  queryIndex: () => ({ ok: true, hits: [{ listingId: 'LST-1', score: 0.97 }, { listingId: 'LST-2', score: 0.8 }] }),
  ...over,
});

const opts = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  categoryAllowList: new Set(['CAT-SAREES', 'CAT-SHOES']),
  featureEnabled: true,
  ...over,
});

const ingested = (d = detectors(), u = upload(), optIn = false): ProcessedImage => {
  const r = ingest(u, d, optIn);
  if (!r.ok) throw new Error('ingest failed: ' + JSON.stringify(r.violations));
  return r.image;
};

// ============================================ EXIF removal, for real

describe('EXIF including GPS is actually REMOVED from the bytes (SECURITY)', () => {
  it('drops the APP1 segment carrying the GPS coordinates', () => {
    const original = jpegWithExifGps();
    const originalText = Buffer.from(original).toString('ascii');
    expect(originalText).toContain('GPSLatitude');
    expect(originalText).toContain('76.9558');

    const stripped = stripExifJpeg(original);
    const strippedText = Buffer.from(stripped.bytes).toString('ascii');

    // a customer photographing a product on their kitchen table would otherwise upload their
    // home's coordinates to a search index
    expect(strippedText).not.toContain('GPSLatitude');
    expect(strippedText).not.toContain('76.9558');
    expect(strippedText).not.toContain('Exif');
    expect(stripped.segmentsRemoved).toBe(1);
  });

  it('preserves the rest of the file: APP0, the scan data and the markers', () => {
    const stripped = stripExifJpeg(jpegWithExifGps());
    const text = Buffer.from(stripped.bytes).toString('ascii');
    expect(text).toContain('JFIF');
    // SOI and EOI survive
    expect(stripped.bytes[0]).toBe(0xff);
    expect(stripped.bytes[1]).toBe(0xd8);
    expect(stripped.bytes[stripped.bytes.length - 2]).toBe(0xff);
    expect(stripped.bytes[stripped.bytes.length - 1]).toBe(0xd9);
    // scan data is intact
    expect([...stripped.bytes]).toContain(0x56);
    expect(stripped.bytes.length).toBeLessThan(jpegWithExifGps().length);
  });

  it('removes SEVERAL APP1 segments, since EXIF and XMP are both APP1', () => {
    const single = jpegWithExifGps();
    // splice a second APP1 in after the first
    const app1 = [0xff, 0xe1, 0x00, 0x08, 0x58, 0x4d, 0x50, 0x00, 0x00, 0x00];
    const doubled = new Uint8Array([...single.slice(0, 2), ...app1, ...single.slice(2)]);
    expect(stripExifJpeg(doubled).segmentsRemoved).toBe(2);
  });

  it('leaves a non-JPEG buffer untouched rather than corrupting it', () => {
    const png = pngBytes();
    const r = stripExifJpeg(png);
    expect(r.segmentsRemoved).toBe(0);
    expect([...r.bytes]).toEqual([...png]);
  });

  it('an EXIF-free JPEG passes through with nothing removed', () => {
    const clean = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x99, 0xff, 0xd9,
    ]);
    const r = stripExifJpeg(clean);
    expect(r.segmentsRemoved).toBe(0);
    expect(Buffer.from(r.bytes).toString('ascii')).toContain('JFIF');
  });

  it('the ingest path reports the removal', () => {
    const image = ingested();
    expect(image.exifRemoved).toBe(true);
    expect(Buffer.from(image.bytes).toString('ascii')).not.toContain('GPSLatitude');
  });
});

// ============================================ blur BEFORE processing

describe('faces are blurred BEFORE any processing — an ordering property (VALIDATION)', () => {
  it('the EMBEDDER receives the blurred buffer, not the original', () => {
    let seenByEmbedder: Uint8Array | null = null;
    const d = detectors({
      detectFaces: () => 2,
      embed: (bytes) => {
        seenByEmbedder = bytes;
        return [1, 0, 0, 0];
      },
    });

    const image = ingested(d);
    expect(image.facesBlurred).toBe(2);
    searchByImage(image, d, opts());

    expect(seenByEmbedder).not.toBeNull();
    // blurring AFTER embedding would mean the face was already encoded into a vector that
    // outlives the image
    expect(seenByEmbedder![0]).toBe(BLUR_MARKER);
  });

  it('the PRODUCT DETECTOR also receives the blurred buffer', () => {
    let seenByDetector: Uint8Array | null = null;
    const d = detectors({
      detectFaces: () => 1,
      detectProduct: (bytes) => {
        seenByDetector = bytes;
        return { categoryId: 'CAT-SAREES', confidence: 0.9, region: { x: 0, y: 0, width: 1, height: 1 } };
      },
    });
    searchByImage(ingested(d), d, opts());
    expect(seenByDetector![0]).toBe(BLUR_MARKER);
  });

  it('the stored bytes are the blurred ones, so nothing downstream can reach the original', () => {
    const image = ingested(detectors({ detectFaces: () => 3 }));
    expect(image.bytes[0]).toBe(BLUR_MARKER);
    expect(image.facesBlurred).toBe(3);
  });

  it('an image with no faces is not needlessly transformed', () => {
    const image = ingested(detectors({ detectFaces: () => 0 }));
    expect(image.facesBlurred).toBe(0);
    expect(image.bytes[0]).not.toBe(BLUR_MARKER);
  });

  it('blurring happens after EXIF stripping, so the blurrer never sees the GPS bytes', () => {
    let seenByBlurrer: Uint8Array | null = null;
    const d = detectors({
      detectFaces: () => 1,
      blurFaces: (bytes, n) => {
        seenByBlurrer = bytes;
        return new Uint8Array([BLUR_MARKER, ...bytes]);
      },
    });
    ingested(d);
    expect(Buffer.from(seenByBlurrer!).toString('ascii')).not.toContain('GPSLatitude');
  });
});

// ============================================ type sniffing

describe('server-side type sniffing, never the declared MIME (VALIDATION)', () => {
  it('recognises each accepted format from its magic bytes', () => {
    expect(sniffType(jpegWithExifGps())).toBe('JPEG');
    expect(sniffType(pngBytes())).toBe('PNG');
    expect(sniffType(webpBytes())).toBe('WEBP');
    expect(sniffType(heicBytes())).toBe('HEIC');
  });

  it('returns null for content that is not an accepted image', () => {
    // a PHP payload renamed to .jpg is the classic upload attack
    const script = new Uint8Array([...Buffer.from('<?php system($_GET[0]); ?>', 'ascii')]);
    expect(sniffType(script)).toBeNull();
    expect(sniffType(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffType(new Uint8Array(0))).toBeNull();
  });

  it('REJECTS an upload whose declared type contradicts its content', () => {
    const r = ingest(upload({ declaredMime: 'image/png' }), detectors());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((v) => v.code === 'DECLARED_TYPE_DOES_NOT_MATCH_CONTENT')).toBe(true);
    }
  });

  it('rejects unrecognised content outright, whatever it claims to be', () => {
    const script = new Uint8Array([...Buffer.from('<?php echo 1; ?>', 'ascii')]);
    const r = ingest(upload({ bytes: script, declaredMime: 'image/jpeg' }), detectors());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code === 'IMAGE_TYPE_NOT_RECOGNISED')).toBe(true);
  });

  it('accepts the alternate declared spellings for a format', () => {
    expect(ingest(upload({ declaredMime: 'image/jpg' }), detectors()).ok).toBe(true);
    expect(ingest(upload({ bytes: heicBytes(), declaredMime: 'image/heif' }), detectors()).ok).toBe(true);
  });
});

// ============================================ size and NSFW

describe('size and content gates (INPUTS / VALIDATION)', () => {
  it('refuses an image beyond 8 MB and an empty one', () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff], 0);
    const r = ingest(upload({ bytes: huge }), detectors());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code === 'IMAGE_EXCEEDS_8MB')).toBe(true);
    expect(ingest(upload({ bytes: new Uint8Array(0) }), detectors()).ok).toBe(false);
  });

  it('rejects an NSFW image', () => {
    const r = ingest(upload(), detectors({ detectNsfw: () => true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].code).toBe('IMAGE_REJECTED_NSFW');
  });

  it('the NSFW check runs on the STRIPPED bytes, so it cannot be evaded via metadata', () => {
    let seen: Uint8Array | null = null;
    ingest(upload(), detectors({ detectNsfw: (b) => { seen = b; return false; } }));
    expect(Buffer.from(seen!).toString('ascii')).not.toContain('Exif');
  });
});

// ============================================ search

describe('search results, tiering and the category chip (OUTPUTS)', () => {
  it('returns tiered hits with an editable category chip and an analytics event', () => {
    const d = detectors();
    const r = searchByImage(ingested(d), d, opts());
    expect(r.outcome).toBe('RESULTS');
    if (r.outcome !== 'RESULTS') return;
    expect(r.result.hits[0]).toEqual({ listingId: 'LST-1', score: 0.97, tier: 'EXACT_MATCH' });
    // 0.8 sits below the 0.85 VERY_SIMILAR threshold, so this is SIMILAR
    expect(r.result.hits[1].tier).toBe('SIMILAR');
    expect(r.result.detectedCategoryId).toBe('CAT-SAREES');
    expect(r.result.categoryChipEditable).toBe(true);
    expect(r.result.analyticsEvent.type).toBe('image_search.performed.v1');
    expect(r.result.analyticsEvent.hitCount).toBe(2);
  });

  it('tiers similarity at the documented boundaries', () => {
    expect(tierFor(0.95)).toBe('EXACT_MATCH');
    expect(tierFor(0.94)).toBe('VERY_SIMILAR');
    expect(tierFor(0.85)).toBe('VERY_SIMILAR');
    expect(tierFor(0.84)).toBe('SIMILAR');
    expect(tierFor(0.70)).toBe('SIMILAR');
    expect(tierFor(0.69)).toBe('RELATED');
  });

  it('a text refinement NARROWS the visual results rather than replacing them', () => {
    const d = detectors();
    const r = searchByImage(ingested(d), d, opts({
      textRefinement: 'navy silk',
      titlesByListingId: { 'LST-1': 'Navy silk saree', 'LST-2': 'Red cotton saree' },
    }));
    if (r.outcome !== 'RESULTS') throw new Error('expected results');
    expect(r.result.hits.map((h) => h.listingId)).toEqual(['LST-1']);
  });

  it('a refinement matching nothing yields an empty grid rather than ignoring the refinement', () => {
    const d = detectors();
    const r = searchByImage(ingested(d), d, opts({
      textRefinement: 'linen',
      titlesByListingId: { 'LST-1': 'Navy silk saree', 'LST-2': 'Red cotton saree' },
    }));
    if (r.outcome !== 'RESULTS') throw new Error('expected results');
    expect(r.result.hits).toEqual([]);
  });

  it('respects the result limit', () => {
    const d = detectors();
    const r = searchByImage(ingested(d), d, opts({ limit: 1 }));
    if (r.outcome === 'RESULTS') expect(r.result.hits).toHaveLength(1);
  });

  it('passes an optional crop box through to the detector', () => {
    let seenCrop: unknown = 'unset';
    const d = detectors({
      detectProduct: (_b, crop) => {
        seenCrop = crop;
        return { categoryId: 'CAT-SAREES', confidence: 0.9, region: { x: 0, y: 0, width: 1, height: 1 } };
      },
    });
    const crop = { x: 10, y: 20, width: 100, height: 200 };
    searchByImage(ingested(d), d, opts({ crop }));
    expect(seenCrop).toEqual(crop);
  });
});

// ============================================ guidance and the flag

describe('no product detected yields guidance, not an empty grid (ERRORS)', () => {
  it('offers framing tips and a text-search fallback', () => {
    const d = detectors({ detectProduct: () => null });
    const r = searchByImage(ingested(d), d, opts());
    expect(r.outcome).toBe('GUIDANCE');
    if (r.outcome !== 'GUIDANCE') return;
    expect(r.guidance.framingTips.length).toBeGreaterThanOrEqual(3);
    expect(r.guidance.textSearchFallback).toBe(true);
    expect(r.guidance.message).toContain('could not identify');
  });

  it('a category outside the allow-list is refused', () => {
    const d = detectors({
      detectProduct: () => ({ categoryId: 'CAT-PROHIBITED', confidence: 0.99, region: { x: 0, y: 0, width: 1, height: 1 } }),
    });
    const r = searchByImage(ingested(d), d, opts());
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') {
      expect(r.violations[0].code).toBe('CATEGORY_NOT_IMAGE_SEARCHABLE');
    }
  });

  it('the feature hides behind its flag WITHOUT processing the upload', () => {
    let embedCalled = false;
    const d = detectors({ embed: () => { embedCalled = true; return [1]; } });
    const r = searchByImage(ingested(d), d, opts({ featureEnabled: false }));
    expect(r.outcome).toBe('FEATURE_HIDDEN');
    if (r.outcome === 'FEATURE_HIDDEN') expect(r.toast).toContain('temporarily unavailable');
    // a disabled feature should not process an upload at all
    expect(embedCalled).toBe(false);
  });

  it('an embedding failure hides the feature rather than showing a broken grid', () => {
    const d = detectors({ embed: () => { throw new Error('service down'); } });
    expect(searchByImage(ingested(d), d, opts()).outcome).toBe('FEATURE_HIDDEN');

    const empty = detectors({ embed: () => [] });
    expect(searchByImage(ingested(empty), empty, opts()).outcome).toBe('FEATURE_HIDDEN');
  });

  it('an index query failure is surfaced rather than shown as no results', () => {
    const d = detectors({ queryIndex: () => ({ ok: false, reason: 'SCHEMA_HASH_MISMATCH' }) });
    const r = searchByImage(ingested(d), d, opts());
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') {
      expect(r.violations[0].code).toBe('INDEX_QUERY_FAILED');
      expect(r.violations[0].detail).toBe('SCHEMA_HASH_MISMATCH');
    }
  });
});

// ============================================ retention and training

describe('retention is seven days, then purge (RULES)', () => {
  it('sets the purge deadline on ingest', () => {
    const image = ingested();
    expect(image.purgeAfterMs).toBe(NOW + RETENTION_MS);
    expect(RETENTION_MS).toBe(7 * 24 * 3_600_000);
  });

  it('is due for purge at the boundary, not before', () => {
    const image = ingested();
    expect(isDueForPurge(image, NOW + RETENTION_MS - 1)).toBe(false);
    expect(isDueForPurge(image, NOW + RETENTION_MS)).toBe(true);
  });

  it('purges only what has expired', () => {
    const old = ingested(detectors(), upload({ uploadId: 'UP-OLD', uploadedAtMs: NOW - 8 * 24 * 3_600_000 }));
    const fresh = ingested(detectors(), upload({ uploadId: 'UP-NEW' }));
    const report = purgeExpired([old, fresh], NOW);
    expect(report.purgedUploadIds).toEqual(['UP-OLD']);
    expect(report.retainedUploadIds).toEqual(['UP-NEW']);
  });
});

describe('training use requires an explicit opt-in (RULES)', () => {
  it('is refused by default', () => {
    const r = mayUseForTraining(ingested());
    expect(r.permitted).toBe(false);
    if (!r.permitted) expect(r.reason).toBe('NO_EXPLICIT_TRAINING_OPT_IN');
  });

  it('is permitted with an explicit opt-in on a face-free image', () => {
    expect(mayUseForTraining(ingested(detectors(), upload(), true)).permitted).toBe(true);
  });

  it('is refused even WITH consent when the frame contained a face', () => {
    const image = ingested(detectors({ detectFaces: () => 1 }), upload(), true);
    const r = mayUseForTraining(image);
    expect(r.permitted).toBe(false);
    // the consent was the uploader's; the other person in the photo did not give one
    if (!r.permitted) expect(r.reason).toBe('IMAGE_CONTAINED_FACES');
  });
});

describe('signed, expiring URLs (SECURITY)', () => {
  it('expires after the configured lifetime', () => {
    const url = signedUrl(ingested(), 'https://img.pixcart.in/search', 'sig-abc', NOW);
    expect(url.expiresAtMs).toBe(NOW + SIGNED_URL_TTL_MS);
    expect(isUrlValid(url, NOW + SIGNED_URL_TTL_MS - 1)).toBe(true);
    expect(isUrlValid(url, NOW + SIGNED_URL_TTL_MS)).toBe(false);
    expect(url.url).toContain('sig=sig-abc');
  });
});
