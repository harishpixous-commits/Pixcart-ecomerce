package com.pixous.pixcart.identity.security;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * TOTP-secret confidentiality (V002 {@code secret_enc}, Vol. 10 §10.4).
 *
 * <p>The HKDF is checked against RFC 5869's published test vectors rather than against a
 * fixture of my own making, so the key derivation is correct against the standard and not
 * merely self-consistent.
 */
class MfaSecretCipherTest {

    private static final String SIGNING_SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-32bytes";
    private static final HexFormat HEX = HexFormat.of();

    private final MfaSecretCipher cipher = new MfaSecretCipher(SIGNING_SECRET);

    @Test
    void hkdfMatchesRfc5869TestCase1() {
        byte[] ikm = filled(0x0b, 22);
        byte[] salt = HEX.parseHex("000102030405060708090a0b0c");
        byte[] info = HEX.parseHex("f0f1f2f3f4f5f6f7f8f9");

        byte[] okm = MfaSecretCipher.hkdfSha256(salt, ikm, info, 42);

        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                + "34007208d5b887185865", HEX.formatHex(okm));
    }

    @Test
    void hkdfMatchesRfc5869TestCase3WithAnEmptySaltAndInfo() {
        byte[] ikm = filled(0x0b, 22);
        byte[] okm = MfaSecretCipher.hkdfSha256(new byte[0], ikm, new byte[0], 42);

        assertEquals("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
                + "9d201395faa4b61a96c8", HEX.formatHex(okm));
    }

    @Test
    void aNullSaltIsTreatedAsTheAllZeroSaltTheRfcDefines() {
        byte[] ikm = filled(0x0b, 22);
        assertArrayEquals(
                MfaSecretCipher.hkdfSha256(new byte[32], ikm, "info".getBytes(StandardCharsets.UTF_8), 32),
                MfaSecretCipher.hkdfSha256(null, ikm, "info".getBytes(StandardCharsets.UTF_8), 32));
    }

    @Test
    void theDerivedKeyIsNotTheSigningKeyAndIsStable() {
        byte[] signing = SIGNING_SECRET.getBytes(StandardCharsets.UTF_8);
        byte[] derived = MfaSecretCipher.hkdfSha256(null, signing,
                MfaSecretCipher.HKDF_LABEL.getBytes(StandardCharsets.UTF_8), 32);

        assertEquals(32, derived.length);
        assertFalse(java.util.Arrays.equals(signing, derived),
                "the encryption key must be derived, never the signing key itself");
        assertArrayEquals(derived, MfaSecretCipher.hkdfSha256(null, signing,
                MfaSecretCipher.HKDF_LABEL.getBytes(StandardCharsets.UTF_8), 32));
        assertNotEquals(HexFormat.of().formatHex(derived), HexFormat.of().formatHex(
                MfaSecretCipher.hkdfSha256(null, signing,
                        "pixcart/identity/mfa-totp-secret/v2".getBytes(StandardCharsets.UTF_8), 32)),
                "the versioned label must partition keys, or re-labelling would silently re-use them");
    }

    @Test
    void encryptThenDecryptRoundTrips() {
        String secret = "JBSWY3DPEHPK3PXP";
        assertEquals(secret, cipher.decrypt(cipher.encrypt(secret)));
    }

    @Test
    void eachEncryptionUsesAFreshNonce() {
        byte[] a = cipher.encrypt("JBSWY3DPEHPK3PXP");
        byte[] b = cipher.encrypt("JBSWY3DPEHPK3PXP");
        assertFalse(java.util.Arrays.equals(a, b), "same plaintext, different ciphertext");
    }

    @Test
    void aTamperedCiphertextIsRefusedNotDecrypted() {
        byte[] blob = cipher.encrypt("JBSWY3DPEHPK3PXP");
        blob[blob.length - 1] ^= 0x01;                       // flip one bit of the GCM tag
        assertThrows(IllegalArgumentException.class, () -> cipher.decrypt(blob));
    }

    @Test
    void aCiphertextFromAnotherServiceKeyCannotBeRead() {
        byte[] blob = new MfaSecretCipher("a completely different 32-byte secret!!")
                .encrypt("JBSWY3DPEHPK3PXP");
        assertThrows(IllegalArgumentException.class, () -> cipher.decrypt(blob));
    }

    @Test
    void truncatedBlobsAreRefusedByName() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> cipher.decrypt(new byte[12]));
        assertTrue(e.getMessage().contains("too short"));
        assertThrows(IllegalArgumentException.class, () -> cipher.decrypt(null));
    }

    @Test
    void recoveryCodeComparisonIsConstantTimeOverBothNullsAndLengths() {
        assertTrue(MfaSecretCipher.constantTimeEquals(new byte[]{1, 2}, new byte[]{1, 2}));
        assertFalse(MfaSecretCipher.constantTimeEquals(new byte[]{1, 2}, new byte[]{1, 3}));
        assertFalse(MfaSecretCipher.constantTimeEquals(new byte[]{1, 2}, new byte[]{1}));
        assertFalse(MfaSecretCipher.constantTimeEquals(null, new byte[]{1}));
        assertFalse(MfaSecretCipher.constantTimeEquals(new byte[]{1}, null));
    }

    private static byte[] filled(int value, int length) {
        byte[] out = new byte[length];
        java.util.Arrays.fill(out, (byte) value);
        return out;
    }
}
