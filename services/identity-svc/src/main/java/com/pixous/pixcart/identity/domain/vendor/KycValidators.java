package com.pixous.pixcart.identity.domain.vendor;

import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * KYC field validators — FR-VEN-001 VALIDATION.
 *
 * Normative source (Documentation Suite v1.0), FR-VEN-001:
 *   VALIDATION: "GSTIN checksum + live verify; PAN format + name-match ≥ 0.8 similarity;
 *                IFSC directory check; penny-drop name match; file types pdf/jpg/png
 *                ≤ 5 MB each."
 *
 * Everything here is offline and deterministic — the "live verify" (GSTN portal), the IFSC
 * directory lookup and the penny-drop itself are provider calls injected as facts; this
 * class implements the checks that can and must be done before spending a provider call:
 * the GSTIN mod-36 check digit, PAN structure and holder-type consistency, IFSC structure,
 * name-similarity scoring, and document type/size rules.
 */
public final class KycValidators {

    private static final String BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    private static final Pattern PAN = Pattern.compile("^[A-Z]{5}[0-9]{4}[A-Z]$");
    private static final Pattern IFSC = Pattern.compile("^[A-Z]{4}0[A-Z0-9]{6}$");
    private static final Pattern GSTIN_SHAPE = Pattern.compile("^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$");

    /** State codes 01–38 are assigned; 97 (other territory) and 99 are also in use. */
    private static final Set<String> VALID_STATE_CODES;
    static {
        var s = new java.util.HashSet<String>();
        for (int i = 1; i <= 38; i++) s.add(String.format("%02d", i));
        s.add("97");
        s.add("99");
        VALID_STATE_CODES = Set.copyOf(s);
    }

    /** PAN 4th character encodes the holder type. */
    public enum PanHolderType { INDIVIDUAL, COMPANY, HUF, FIRM, ASSOCIATION_OF_PERSONS, TRUST, GOVERNMENT, LOCAL_AUTHORITY, ARTIFICIAL_JURIDICAL, BODY_OF_INDIVIDUALS, UNKNOWN }

    /** Allowed KYC document formats and the per-file size ceiling. */
    public static final Set<String> ALLOWED_DOC_TYPES = Set.of("pdf", "jpg", "jpeg", "png");
    public static final long MAX_DOC_BYTES = 5L * 1024 * 1024;   // 5 MB each
    public static final double NAME_MATCH_THRESHOLD = 0.80;      // ≥ 0.8 similarity

    private KycValidators() {
    }

    // ------------------------------------------------------------------ GSTIN

    /**
     * GSTIN check-digit validation (mod-36). For each of the first 14 characters take its
     * base-36 value, multiply by an alternating factor of 1 and 2, add the base-36 digit sum
     * of each product; the check character is base36[(36 − sum mod 36) mod 36].
     */
    public static boolean isGstinChecksumValid(String gstin) {
        if (gstin == null || gstin.length() != 15) return false;
        String g = gstin.toUpperCase(Locale.ROOT);
        int sum = 0;
        for (int i = 0; i < 14; i++) {
            int v = BASE36.indexOf(g.charAt(i));
            if (v < 0) return false;
            int product = v * ((i % 2 == 0) ? 1 : 2);
            sum += (product / 36) + (product % 36);
        }
        char expected = BASE36.charAt((36 - (sum % 36)) % 36);
        return expected == g.charAt(14);
    }

    /** Structure + state code + check digit. "Live verify" is a provider fact, not this. */
    public static boolean isGstinWellFormed(String gstin) {
        if (gstin == null) return false;
        String g = gstin.toUpperCase(Locale.ROOT);
        if (!GSTIN_SHAPE.matcher(g).matches()) return false;
        if (!VALID_STATE_CODES.contains(g.substring(0, 2))) return false;
        return isGstinChecksumValid(g);
    }

    /** Characters 3–12 of a GSTIN are the holder's PAN — a free cross-check. */
    public static String panFromGstin(String gstin) {
        if (gstin == null || gstin.length() != 15) return null;
        return gstin.toUpperCase(Locale.ROOT).substring(2, 12);
    }

    // -------------------------------------------------------------------- PAN

    public static boolean isPanWellFormed(String pan) {
        return pan != null && PAN.matcher(pan.toUpperCase(Locale.ROOT)).matches();
    }

    public static PanHolderType panHolderType(String pan) {
        if (!isPanWellFormed(pan)) return PanHolderType.UNKNOWN;
        return switch (pan.toUpperCase(Locale.ROOT).charAt(3)) {
            case 'P' -> PanHolderType.INDIVIDUAL;
            case 'C' -> PanHolderType.COMPANY;
            case 'H' -> PanHolderType.HUF;
            case 'F' -> PanHolderType.FIRM;
            case 'A' -> PanHolderType.ASSOCIATION_OF_PERSONS;
            case 'T' -> PanHolderType.TRUST;
            case 'G' -> PanHolderType.GOVERNMENT;
            case 'L' -> PanHolderType.LOCAL_AUTHORITY;
            case 'J' -> PanHolderType.ARTIFICIAL_JURIDICAL;
            case 'B' -> PanHolderType.BODY_OF_INDIVIDUALS;
            default -> PanHolderType.UNKNOWN;
        };
    }

    /**
     * The PAN's 5th character is the first letter of the surname (individuals) or of the
     * entity name — a structural name check that costs nothing.
     */
    public static boolean panInitialMatchesName(String pan, String legalName) {
        if (!isPanWellFormed(pan) || legalName == null || legalName.isBlank()) return false;
        String normalised = normaliseName(legalName);
        if (normalised.isEmpty()) return false;
        return pan.toUpperCase(Locale.ROOT).charAt(4) == normalised.charAt(0);
    }

    // ------------------------------------------------------------------- IFSC

    public static boolean isIfscWellFormed(String ifsc) {
        return ifsc != null && IFSC.matcher(ifsc.toUpperCase(Locale.ROOT)).matches();
    }

    // --------------------------------------------------------- name matching

    /** Corporate suffixes stripped before comparison so PVT LTD ≡ PRIVATE LIMITED. */
    private static final String[][] SUFFIX_CANON = {
            {"PRIVATE LIMITED", ""}, {"PVT LTD", ""}, {"PVT. LTD.", ""}, {"PVT LIMITED", ""},
            {"PUBLIC LIMITED", ""}, {"LIMITED", ""}, {"LTD", ""},
            {"LLP", ""}, {"AND", "&"},
    };

    /** Upper-case, strip punctuation, canonicalise suffixes, collapse whitespace. */
    public static String normaliseName(String name) {
        if (name == null) return "";
        String n = name.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9& ]", " ");
        n = n.replaceAll("\\s+", " ").trim();
        for (String[] pair : SUFFIX_CANON) {
            n = n.replace(pair[0], pair[1]);
        }
        return n.replaceAll("\\s+", " ").trim();
    }

    /**
     * Similarity in [0,1] — normalised Levenshtein over canonicalised names. Used for the
     * PAN name-match and the penny-drop name-match, both gated at ≥ 0.8.
     */
    public static double nameSimilarity(String a, String b) {
        String x = normaliseName(a);
        String y = normaliseName(b);
        if (x.isEmpty() && y.isEmpty()) return 1.0;
        if (x.isEmpty() || y.isEmpty()) return 0.0;
        if (x.equals(y)) return 1.0;
        int distance = levenshtein(x, y);
        int max = Math.max(x.length(), y.length());
        return 1.0 - ((double) distance / max);
    }

    public static boolean namesMatch(String a, String b) {
        return nameSimilarity(a, b) >= NAME_MATCH_THRESHOLD;
    }

    private static int levenshtein(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) prev[j] = j;
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] swap = prev; prev = cur; cur = swap;
        }
        return prev[b.length()];
    }

    // --------------------------------------------------------------- documents

    public record DocumentRef(String kind, String fileName, long sizeBytes) {}

    public sealed interface DocCheck {
        record Ok() implements DocCheck {}
        record Rejected(String reason) implements DocCheck {}
    }

    public static DocCheck checkDocument(DocumentRef d) {
        if (d.fileName() == null || !d.fileName().contains(".")) {
            return new DocCheck.Rejected("DOC_NO_EXTENSION");
        }
        String ext = d.fileName().substring(d.fileName().lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        if (!ALLOWED_DOC_TYPES.contains(ext)) return new DocCheck.Rejected("DOC_TYPE_NOT_ALLOWED: " + ext);
        if (d.sizeBytes() <= 0) return new DocCheck.Rejected("DOC_EMPTY");
        if (d.sizeBytes() > MAX_DOC_BYTES) return new DocCheck.Rejected("DOC_OVER_5MB");
        return new DocCheck.Ok();
    }
}
