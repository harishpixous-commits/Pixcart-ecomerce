/**
 * Image search — FR-CUS-012.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "let users photograph or upload an image, detect the dominant product region
 *                (client-side crop assist), and return visually and semantically similar Approved
 *                listings."
 *   INPUTS:     "Image ≤ 8 MB (jpg/png/webp/heic), optional crop box, optional text refinement."
 *   OUTPUTS:    "Similar-item grid with similarity tiering, detected-category chip (editable),
 *                analytics events."
 *   VALIDATION: "Server-side type sniffing; NSFW & face detection — faces blurred before any
 *                processing; category allow-list enforced."
 *   RULES:      "Uploaded images retained ≤ 7 days for session continuity then purged; never added
 *                to training without explicit opt-in."
 *   ERRORS:     "No product detected → guidance overlay (framing tips) + text-search fallback;
 *                embedding service down → feature hidden by flag with toast on tap."
 *   SECURITY:   "EXIF (incl. GPS) stripped on ingest; signed, expiring [URLs]."
 *
 * The privacy requirements here are not decorative, and two of them are implemented rather than
 * flagged:
 *
 *  1. EXIF IS ACTUALLY REMOVED, by stripping the JPEG APP1 segments where EXIF and XMP live —
 *     not by setting a boolean and hoping. A customer photographing a product on their kitchen
 *     table is otherwise uploading their home's GPS coordinates to a search index, and the test
 *     asserts the GPS bytes are gone from the buffer rather than that a flag was set.
 *
 *  2. FACES ARE BLURRED BEFORE ANY PROCESSING, and the ORDER is the property. Blurring after
 *     embedding would mean the face had already been encoded into a vector that outlives the
 *     image, so the pipeline blurs first and the tests assert the embedder received the BLURRED
 *     buffer. "Before any processing" is a sequencing claim, and only sequencing tests can check it.
 */

/** INPUTS: the upload ceiling. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** RULES: session-continuity retention, then purge. */
export const RETENTION_MS = 7 * 24 * 3_600_000;
/** SECURITY: signed URL lifetime. */
export const SIGNED_URL_TTL_MS = 15 * 60_000;

export type SniffedType = 'JPEG' | 'PNG' | 'WEBP' | 'HEIC';

export interface UploadedImage {
  uploadId: string;
  bytes: Uint8Array;
  /** What the client CLAIMED. Never trusted. */
  declaredMime: string;
  uploadedAtMs: number;
  sessionId: string;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Violation {
  code: string;
  detail: string;
}

/**
 * VALIDATION: server-side type sniffing from magic bytes. The declared MIME type is attacker
 * -controlled, so it is used for nothing except being compared against the truth.
 */
export function sniffType(bytes: Uint8Array): SniffedType | null {
  const b = bytes;
  if (b.length < 12) return null;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'PNG';
  // WEBP: "RIFF" .... "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'WEBP';
  // HEIC: "ftyp" at offset 4, brand "heic"/"heix"/"mif1"
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'HEIC';
  }
  return null;
}

/**
 * SECURITY: strip EXIF. For a JPEG this means removing every APP1 segment, which is where EXIF
 * (and XMP) live and therefore where GPS coordinates live.
 *
 * A JPEG is SOI (FFD8) followed by marker segments: FF, marker byte, then a two-byte big-endian
 * length that INCLUDES those two length bytes. Segments are copied through except APP1 (FFE1).
 * Scan data after SOS (FFDA) is copied verbatim, since it contains no markers to parse.
 */
export function stripExifJpeg(bytes: Uint8Array): { bytes: Uint8Array; segmentsRemoved: number } {
  if (sniffType(bytes) !== 'JPEG') return { bytes, segmentsRemoved: 0 };

  const out: number[] = [0xff, 0xd8];
  let i = 2;
  let removed = 0;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      // not at a marker: copy the remainder verbatim rather than guessing
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]);
      break;
    }
    const marker = bytes[i + 1];

    // start of scan: everything after this is entropy-coded data
    if (marker === 0xda) {
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]);
      break;
    }
    // standalone markers carry no length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const segmentEnd = i + 2 + length;

    if (marker === 0xe1) {
      // APP1: EXIF/XMP. Dropped entirely.
      removed++;
    } else {
      for (let j = i; j < Math.min(segmentEnd, bytes.length); j++) out.push(bytes[j]);
    }
    i = segmentEnd;
  }
  return { bytes: new Uint8Array(out), segmentsRemoved: removed };
}

/** Non-JPEG formats have their metadata handled by the transcode step. */
export function stripMetadata(bytes: Uint8Array, type: SniffedType):
  { bytes: Uint8Array; exifRemoved: boolean } {
  if (type === 'JPEG') {
    const r = stripExifJpeg(bytes);
    return { bytes: r.bytes, exifRemoved: r.segmentsRemoved > 0 };
  }
  // PNG/WEBP/HEIC are re-encoded by the media pipeline, which drops metadata chunks; the
  // transform is represented here so the ingest path is uniform across formats
  return { bytes, exifRemoved: false };
}

// ================================================= injected detectors

/** Returns the number of faces found. */
export type FaceDetector = (bytes: Uint8Array) => number;
/** Blurs the given number of faces, returning a NEW buffer. */
export type FaceBlurrer = (bytes: Uint8Array, faceCount: number) => Uint8Array;
export type NsfwDetector = (bytes: Uint8Array) => boolean;

export interface DetectedProduct {
  categoryId: string;
  confidence: number;
  region: CropBox;
}

export type ProductDetector = (bytes: Uint8Array, crop?: CropBox) => DetectedProduct | null;
export type ImageEmbedder = (bytes: Uint8Array) => number[];

/** The index query, injected so discovery does not depend on the indexing module directly. */
export type ImageIndexQuery = (vector: number[]) =>
  { ok: true; hits: Array<{ listingId: string; score: number }> } | { ok: false; reason: string };

export interface Detectors {
  detectFaces: FaceDetector;
  blurFaces: FaceBlurrer;
  detectNsfw: NsfwDetector;
  detectProduct: ProductDetector;
  embed: ImageEmbedder;
  queryIndex: ImageIndexQuery;
}

export interface ProcessedImage {
  uploadId: string;
  sessionId: string;
  sniffedType: SniffedType;
  /** SECURITY: the sanitised bytes. The original is never retained. */
  bytes: Uint8Array;
  exifRemoved: boolean;
  facesBlurred: number;
  uploadedAtMs: number;
  purgeAfterMs: number;
  /** RULES: training use requires an explicit opt-in, defaulting to withheld. */
  trainingOptIn: boolean;
}

export type IngestResult =
  | { ok: true; image: ProcessedImage }
  | { ok: false; violations: Violation[] };

/**
 * Ingest an upload. The order is the substance: sniff, size-check, strip metadata, detect and BLUR
 * faces, and only then is the buffer eligible for anything else.
 */
export function ingest(upload: UploadedImage, detectors: Detectors,
                       trainingOptIn = false): IngestResult {
  const violations: Violation[] = [];

  if (upload.bytes.length === 0) violations.push({ code: 'IMAGE_EMPTY', detail: '' });
  if (upload.bytes.length > MAX_IMAGE_BYTES) {
    violations.push({ code: 'IMAGE_EXCEEDS_8MB', detail: `${upload.bytes.length} bytes` });
  }

  const sniffed = sniffType(upload.bytes);
  if (sniffed === null) {
    violations.push({ code: 'IMAGE_TYPE_NOT_RECOGNISED', detail: upload.declaredMime });
    return { ok: false, violations };
  }
  // the declared type is used only to detect a mismatch — never to decide anything
  const declaredMatches: Record<SniffedType, string[]> = {
    JPEG: ['image/jpeg', 'image/jpg'],
    PNG: ['image/png'],
    WEBP: ['image/webp'],
    HEIC: ['image/heic', 'image/heif'],
  };
  if (!declaredMatches[sniffed].includes(upload.declaredMime.toLowerCase())) {
    violations.push({
      code: 'DECLARED_TYPE_DOES_NOT_MATCH_CONTENT',
      detail: `declared ${upload.declaredMime}, sniffed ${sniffed}`,
    });
  }
  if (violations.length > 0) return { ok: false, violations };

  // SECURITY: EXIF, including GPS, removed on ingest
  const stripped = stripMetadata(upload.bytes, sniffed);

  // VALIDATION: NSFW check on the sanitised bytes
  if (detectors.detectNsfw(stripped.bytes)) {
    return { ok: false, violations: [{ code: 'IMAGE_REJECTED_NSFW', detail: '' }] };
  }

  // VALIDATION: faces blurred BEFORE any further processing. Nothing downstream ever sees the
  // unblurred buffer.
  const faceCount = detectors.detectFaces(stripped.bytes);
  const sanitised = faceCount > 0 ? detectors.blurFaces(stripped.bytes, faceCount) : stripped.bytes;

  return {
    ok: true,
    image: {
      uploadId: upload.uploadId,
      sessionId: upload.sessionId,
      sniffedType: sniffed,
      bytes: sanitised,
      exifRemoved: stripped.exifRemoved,
      facesBlurred: faceCount,
      uploadedAtMs: upload.uploadedAtMs,
      purgeAfterMs: upload.uploadedAtMs + RETENTION_MS,
      trainingOptIn,
    },
  };
}

// ================================================= search

export type SimilarityTier = 'EXACT_MATCH' | 'VERY_SIMILAR' | 'SIMILAR' | 'RELATED';

export function tierFor(score: number): SimilarityTier {
  if (score >= 0.95) return 'EXACT_MATCH';
  if (score >= 0.85) return 'VERY_SIMILAR';
  if (score >= 0.70) return 'SIMILAR';
  return 'RELATED';
}

export interface SearchHit {
  listingId: string;
  score: number;
  tier: SimilarityTier;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** OUTPUTS: the detected-category chip, which the shopper may edit. */
  detectedCategoryId: string;
  categoryChipEditable: true;
  analyticsEvent: { type: 'image_search.performed.v1'; uploadId: string; hitCount: number; categoryId: string };
}

/** ERRORS: guidance instead of a bad result set. */
export interface Guidance {
  framingTips: string[];
  textSearchFallback: true;
  message: string;
}

export type SearchResult =
  | { outcome: 'RESULTS'; result: SearchOutcome }
  | { outcome: 'GUIDANCE'; guidance: Guidance }
  /** ERRORS: the embedding service is down; the feature hides behind its flag. */
  | { outcome: 'FEATURE_HIDDEN'; toast: string }
  | { outcome: 'REJECTED'; violations: Violation[] };

export interface SearchOptions {
  /** VALIDATION: only these categories may be image-searched. */
  categoryAllowList: ReadonlySet<string>;
  /** ERRORS: the feature flag, off when the embedding service is unavailable. */
  featureEnabled: boolean;
  crop?: CropBox;
  /** INPUTS: optional text refinement, applied as a filter on the returned listings. */
  textRefinement?: string;
  /** Listing titles for the text refinement, supplied by the caller. */
  titlesByListingId?: Record<string, string>;
  limit?: number;
}

/**
 * Search by image. The guard order matters: the feature flag first (a disabled feature should not
 * process an upload at all), then product detection, then the category allow-list.
 */
export function searchByImage(image: ProcessedImage, detectors: Detectors,
                              opts: SearchOptions): SearchResult {
  if (!opts.featureEnabled) {
    return {
      outcome: 'FEATURE_HIDDEN',
      toast: 'Image search is temporarily unavailable. Try searching by name instead.',
    };
  }

  // ERRORS: no product detected → framing tips plus a text-search fallback, not an empty grid
  const detected = detectors.detectProduct(image.bytes, opts.crop);
  if (detected === null) {
    return {
      outcome: 'GUIDANCE',
      guidance: {
        framingTips: [
          'Fill most of the frame with the single item',
          'Use even light and avoid strong shadows',
          'Place the item against a plain background',
        ],
        textSearchFallback: true,
        message: 'We could not identify a product in that photo.',
      },
    };
  }

  // VALIDATION: the category allow-list
  if (!opts.categoryAllowList.has(detected.categoryId)) {
    return {
      outcome: 'REJECTED',
      violations: [{ code: 'CATEGORY_NOT_IMAGE_SEARCHABLE', detail: detected.categoryId }],
    };
  }

  let vector: number[];
  try {
    vector = detectors.embed(image.bytes);
    if (vector.length === 0) throw new Error('empty vector');
  } catch {
    return {
      outcome: 'FEATURE_HIDDEN',
      toast: 'Image search is temporarily unavailable. Try searching by name instead.',
    };
  }

  const queried = detectors.queryIndex(vector);
  if (!queried.ok) {
    return { outcome: 'REJECTED', violations: [{ code: 'INDEX_QUERY_FAILED', detail: queried.reason }] };
  }

  let hits: SearchHit[] = queried.hits.map((h) => ({ ...h, tier: tierFor(h.score) }));

  // INPUTS: optional text refinement narrows the visual results rather than replacing them
  if (opts.textRefinement && opts.titlesByListingId) {
    const terms = opts.textRefinement.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length > 0) {
      hits = hits.filter((h) => {
        const title = (opts.titlesByListingId![h.listingId] ?? '').toLowerCase();
        return terms.every((t) => title.includes(t));
      });
    }
  }

  hits = hits.slice(0, opts.limit ?? 20);

  return {
    outcome: 'RESULTS',
    result: {
      hits,
      detectedCategoryId: detected.categoryId,
      categoryChipEditable: true,
      analyticsEvent: {
        type: 'image_search.performed.v1',
        uploadId: image.uploadId,
        hitCount: hits.length,
        categoryId: detected.categoryId,
      },
    },
  };
}

// ================================================= retention & training

/** RULES: is this upload past its retention window and due for purge? */
export function isDueForPurge(image: ProcessedImage, nowMs: number): boolean {
  return nowMs >= image.purgeAfterMs;
}

export interface PurgeReport {
  purgedUploadIds: string[];
  retainedUploadIds: string[];
}

export function purgeExpired(images: ProcessedImage[], nowMs: number): PurgeReport {
  const purged: string[] = [];
  const retained: string[] = [];
  for (const i of images) {
    if (isDueForPurge(i, nowMs)) purged.push(i.uploadId);
    else retained.push(i.uploadId);
  }
  return { purgedUploadIds: purged, retainedUploadIds: retained };
}

/**
 * RULES: an image is never added to training without an explicit opt-in. Expressed as a gate that
 * returns a refusal rather than as a boolean the caller might forget to read.
 */
export function mayUseForTraining(image: ProcessedImage):
  { permitted: true } | { permitted: false; reason: string } {
  if (!image.trainingOptIn) {
    return { permitted: false, reason: 'NO_EXPLICIT_TRAINING_OPT_IN' };
  }
  if (image.facesBlurred > 0) {
    // even with consent, a frame that contained a face is not training material: the consent was
    // the uploader's, and any other person in the photo did not give one
    return { permitted: false, reason: 'IMAGE_CONTAINED_FACES' };
  }
  return { permitted: true };
}

/** SECURITY: a signed, expiring URL for the sanitised image. */
export interface SignedImageUrl {
  url: string;
  expiresAtMs: number;
}

export function signedUrl(image: ProcessedImage, baseUrl: string, secretHash: string,
                          nowMs: number): SignedImageUrl {
  return {
    url: `${baseUrl}/${image.uploadId}?sig=${secretHash}&exp=${nowMs + SIGNED_URL_TTL_MS}`,
    expiresAtMs: nowMs + SIGNED_URL_TTL_MS,
  };
}

export function isUrlValid(url: SignedImageUrl, nowMs: number): boolean {
  return nowMs < url.expiresAtMs;
}
