package com.pixous.pixcart.identity.security;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * Confidentiality for TOTP secrets at rest.
 *
 * <p>V002 {@code id_mfa_factor.secret_enc} is {@code VARBINARY(256)} and its header comment
 * states the secret is "encrypted at rest (Vol. 10 §10.4)". A TOTP secret in the clear is a
 * second password: anyone who reads the row owns the second factor. So this class refuses to
 * store plaintext — the only write path encrypts with AES-256-GCM (authenticated, so a
 * tampered ciphertext fails to decrypt rather than yielding garbage).
 *
 * <p><b>Key separation.</b> The encryption key is HKDF-SHA256(IDENTITY_JWT_SECRET,
 * info = {@value #HKDF_LABEL}). The signing key is never used <em>directly</em> as a cipher
 * key; the derivation label partitions the two uses, which is the standard defence against
 * cross-protocol attacks. {@code HKDF_LABEL} is versioned so a future change forces a new
 * key rather than silently reading old ciphertexts with a new meaning.
 *
 * <p>Wire format: {@code 12-byte nonce || AES-GCM ciphertext||tag}.
 */
public final class MfaSecretCipher {

    /** Domain-separation label; versioned. Changing it invalidates every existing ciphertext. */
    public static final String HKDF_LABEL = "pixcart/identity/mfa-totp-secret/v1";

    static final int NONCE_BYTES = 12;
    static final int TAG_BITS = 128;
    private static final int KEY_BYTES = 32;          // AES-256
    private static final SecureRandom RNG = new SecureRandom();

    private final SecretKeySpec key;

    public MfaSecretCipher(String signingSecret) {
        this(hkdfSha256(null, signingSecret.getBytes(StandardCharsets.UTF_8),
                HKDF_LABEL.getBytes(StandardCharsets.UTF_8), KEY_BYTES));
    }

    /** Visible for tests that inject a raw key. */
    MfaSecretCipher(byte[] keyBytes) {
        if (keyBytes == null || keyBytes.length == 0) throw new IllegalArgumentException("keyBytes");
        this.key = new SecretKeySpec(keyBytes, "AES");
    }

    public byte[] encrypt(String plaintext) {
        if (plaintext == null || plaintext.isEmpty()) throw new IllegalArgumentException("plaintext");
        byte[] nonce = new byte[NONCE_BYTES];
        RNG.nextBytes(nonce);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[nonce.length + ct.length];
            System.arraycopy(nonce, 0, out, 0, nonce.length);
            System.arraycopy(ct, 0, out, nonce.length, ct.length);
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("AES-GCM encryption unavailable", e);
        }
    }

    public String decrypt(byte[] blob) {
        if (blob == null || blob.length <= NONCE_BYTES) {
            throw new IllegalArgumentException("ciphertext is too short to contain a GCM nonce and tag");
        }
        byte[] nonce = Arrays.copyOfRange(blob, 0, NONCE_BYTES);
        byte[] ct = Arrays.copyOfRange(blob, NONCE_BYTES, blob.length);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            // Authentication failure: wrong key, tampered ciphertext or wrong format.
            throw new IllegalArgumentException("stored TOTP secret could not be decrypted", e);
        }
    }

    /** Constant-time comparison used for recovery-code hashes. */
    public static boolean constantTimeEquals(byte[] a, byte[] b) {
        return a != null && b != null && MessageDigest.isEqual(a, b);
    }

    /**
     * RFC 5869 HKDF-SHA256. {@code salt} may be null or empty, both of which RFC 5869 §2.2
     * defines as {@code HashLen} zero bytes.
     */
    public static byte[] hkdfSha256(byte[] salt, byte[] ikm, byte[] info, int length) {
        if (ikm == null || ikm.length == 0) throw new IllegalArgumentException("ikm");
        if (length < 1) throw new IllegalArgumentException("length");
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            // RFC 5869 §2.2: a missing OR EMPTY salt is HashLen zero bytes. An empty
            // SecretKeySpec is rejected by JCA, so this is also the only workable form.
            byte[] saltBytes = (salt == null || salt.length == 0) ? new byte[mac.getMacLength()] : salt;
            mac.init(new SecretKeySpec(saltBytes, "HmacSHA256"));
            byte[] prk = mac.doFinal(ikm);

            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            byte[] okm = new byte[length];
            byte[] previous = new byte[0];
            int filled = 0;
            for (byte counter = 1; filled < length; counter++) {
                mac.reset();
                byte[] block = new byte[previous.length + info.length + 1];
                System.arraycopy(previous, 0, block, 0, previous.length);
                System.arraycopy(info, 0, block, previous.length, info.length);
                block[block.length - 1] = counter;
                previous = mac.doFinal(block);
                int take = Math.min(previous.length, length - filled);
                System.arraycopy(previous, 0, okm, filled, take);
                filled += take;
            }
            return okm;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }
}
