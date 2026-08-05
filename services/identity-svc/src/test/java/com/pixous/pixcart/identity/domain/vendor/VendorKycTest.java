package com.pixous.pixcart.identity.domain.vendor;

import com.pixous.pixcart.identity.domain.vendor.KycValidators.DocumentRef;
import com.pixous.pixcart.identity.domain.vendor.VendorKycApplication.BankAccount;
import com.pixous.pixcart.identity.domain.vendor.VendorKycApplication.BusinessType;
import com.pixous.pixcart.identity.domain.vendor.VendorKycApplication.Outcome;
import com.pixous.pixcart.identity.domain.vendor.VendorKycApplication.PennyDropResult;
import com.pixous.pixcart.identity.domain.vendor.VendorKycApplication.Status;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-VEN-001 KYC validation and the BRU-01 transact gate.
 *
 * The GSTIN fixture is Pixous Technologies' own publicly-published GSTIN (it appears in the
 * documentation suite's letterhead), so the mod-36 checksum test runs against a real,
 * independently-verifiable number rather than a made-up one.
 */
class VendorKycTest {

    private static final String PIXOUS_GSTIN = "33AAMCP3151E1ZO";  // real, checksum-valid
    private static final String PIXOUS_PAN = "AAMCP3151E";         // embedded in the GSTIN
    private static final String LEGAL_NAME = "Pixous Technologies Private Limited";

    // ------------------------------------------------------------ validators

    @Test
    void gstinChecksumAcceptsARealNumberAndRejectsATamperedOne() {
        assertTrue(KycValidators.isGstinChecksumValid(PIXOUS_GSTIN));
        assertTrue(KycValidators.isGstinWellFormed(PIXOUS_GSTIN));
        // flip the check character
        assertFalse(KycValidators.isGstinChecksumValid("33AAMCP3151E1ZA"));
        // alter a payload digit: the original check char no longer matches
        assertFalse(KycValidators.isGstinChecksumValid("33AAMCP3152E1ZO"));
    }

    @Test
    void gstinStructureAndStateCodeAreEnforced() {
        assertFalse(KycValidators.isGstinWellFormed("33AAMCP3151E1Z"));   // 14 chars
        assertFalse(KycValidators.isGstinWellFormed("00AAMCP3151E1ZO"));  // state code 00 invalid
        assertFalse(KycValidators.isGstinWellFormed("33AAMCP3151E1XO"));  // 14th char must be Z
        assertFalse(KycValidators.isGstinWellFormed(null));
    }

    @Test
    void panEmbeddedInGstinIsExtractable() {
        assertEquals(PIXOUS_PAN, KycValidators.panFromGstin(PIXOUS_GSTIN));
    }

    @Test
    void panFormatHolderTypeAndInitialCheck() {
        assertTrue(KycValidators.isPanWellFormed(PIXOUS_PAN));
        assertFalse(KycValidators.isPanWellFormed("AAMCP3151"));      // 9 chars
        assertFalse(KycValidators.isPanWellFormed("AAMC13151E"));     // digit in the letter block
        assertEquals(KycValidators.PanHolderType.COMPANY, KycValidators.panHolderType(PIXOUS_PAN));
        assertEquals(KycValidators.PanHolderType.INDIVIDUAL, KycValidators.panHolderType("ABCPK1234E"));
        // 5th char 'P' matches "Pixous"
        assertTrue(KycValidators.panInitialMatchesName(PIXOUS_PAN, LEGAL_NAME));
        assertFalse(KycValidators.panInitialMatchesName(PIXOUS_PAN, "Zenith Traders"));
    }

    @Test
    void ifscFormat() {
        assertTrue(KycValidators.isIfscWellFormed("HDFC0001234"));
        assertFalse(KycValidators.isIfscWellFormed("HDFC1001234"));    // 5th char must be 0
        assertFalse(KycValidators.isIfscWellFormed("HDFC000123"));     // 10 chars
    }

    @Test
    void nameSimilarityCanonicalisesCorporateSuffixes() {
        assertEquals(1.0, KycValidators.nameSimilarity(
                "Pixous Technologies Private Limited", "PIXOUS TECHNOLOGIES PVT LTD"), 1e-9);
        assertTrue(KycValidators.namesMatch("Pixous Technologies Pvt Ltd", "Pixous Technologies"));
        assertTrue(KycValidators.namesMatch("PIXOUS TECHNOLOGIES", "Pixous  Technologies."));
        assertFalse(KycValidators.namesMatch("Pixous Technologies", "Zenith Traders"));
        assertTrue(KycValidators.nameSimilarity("Pixous Technologies", "Zenith Traders") < KycValidators.NAME_MATCH_THRESHOLD);
    }

    @Test
    void documentTypeAndSizeRules() {
        assertInstanceOf(KycValidators.DocCheck.Ok.class,
                KycValidators.checkDocument(new DocumentRef("GST_CERT", "gst.pdf", 1_000_000)));
        assertInstanceOf(KycValidators.DocCheck.Rejected.class,
                KycValidators.checkDocument(new DocumentRef("GST_CERT", "gst.docx", 1_000)));
        assertInstanceOf(KycValidators.DocCheck.Rejected.class,
                KycValidators.checkDocument(new DocumentRef("GST_CERT", "gst.pdf", 6L * 1024 * 1024)));
        assertInstanceOf(KycValidators.DocCheck.Rejected.class,
                KycValidators.checkDocument(new DocumentRef("GST_CERT", "noextension", 1_000)));
    }

    // ------------------------------------------------------------- aggregate

    private static VendorKycApplication completeApplication() {
        var app = new VendorKycApplication("01VEND000000000000000001A");
        assertInstanceOf(Outcome.Ok.class, app.setIdentity(LEGAL_NAME, BusinessType.PRIVATE_LIMITED, PIXOUS_PAN));
        assertInstanceOf(Outcome.Ok.class, app.setGstin(PIXOUS_GSTIN, true));
        assertInstanceOf(Outcome.Ok.class, app.setBankAccount(
                new BankAccount("50100123456789", "HDFC0001234", LEGAL_NAME),
                new PennyDropResult(true, "PIXOUS TECHNOLOGIES PVT LTD")));
        assertInstanceOf(Outcome.Ok.class, app.addDocument(new DocumentRef("GST_CERT", "gst.pdf", 500_000)));
        app.addCategoryInterest("01CATFASHION00000000000AA");
        app.signAgreement();
        return app;
    }

    @Test
    void pennyDropMustCreditAndNameMustMatch() {
        var app = new VendorKycApplication("01VEND000000000000000002A");
        app.setIdentity(LEGAL_NAME, BusinessType.PRIVATE_LIMITED, PIXOUS_PAN);
        // not credited
        var notCredited = app.setBankAccount(new BankAccount("50100123456789", "HDFC0001234", LEGAL_NAME),
                new PennyDropResult(false, LEGAL_NAME));
        assertTrue(assertInstanceOf(Outcome.Rejected.class, notCredited).violations().contains("PENNY_DROP_FAILED"));
        // credited but a different person's name
        var wrongName = app.setBankAccount(new BankAccount("50100123456789", "HDFC0001234", LEGAL_NAME),
                new PennyDropResult(true, "Zenith Traders"));
        assertTrue(assertInstanceOf(Outcome.Rejected.class, wrongName).violations().contains("PENNY_DROP_NAME_MISMATCH"));
        assertFalse(app.pennyDropVerified());
    }

    @Test
    void gstinMustEmbedTheDeclaredPan() {
        var app = new VendorKycApplication("01VEND000000000000000003A");
        app.setIdentity("Zenith Traders", BusinessType.PROPRIETORSHIP, "ZBCPZ1234K");
        var mismatch = app.setGstin(PIXOUS_GSTIN, true);   // GSTIN carries a different PAN
        assertTrue(assertInstanceOf(Outcome.Rejected.class, mismatch).violations().contains("GSTIN_PAN_MISMATCH"));
    }

    @Test
    void bru01GateNeedsAllThreeConditions() {
        var app = completeApplication();
        assertInstanceOf(Outcome.Ok.class, app.submit());
        assertFalse(app.canTransact(), "submitted is not verified");
        assertInstanceOf(Outcome.Ok.class, app.verify());
        assertTrue(app.canTransact());
        assertEquals(Status.VERIFIED, app.status());
    }

    @Test
    void agreementUnsignedBlocksSubmissionAndTransacting() {
        var app = new VendorKycApplication("01VEND000000000000000004A");
        app.setIdentity(LEGAL_NAME, BusinessType.PRIVATE_LIMITED, PIXOUS_PAN);
        app.setGstin(PIXOUS_GSTIN, true);
        app.setBankAccount(new BankAccount("50100123456789", "HDFC0001234", LEGAL_NAME),
                new PennyDropResult(true, LEGAL_NAME));
        app.addDocument(new DocumentRef("GST_CERT", "gst.pdf", 500_000));
        app.addCategoryInterest("01CATFASHION00000000000AA");
        // no signAgreement()
        var missing = assertInstanceOf(Outcome.Rejected.class, app.submit()).violations();
        assertTrue(missing.contains("AGREEMENT_NOT_SIGNED"));
        assertFalse(app.canTransact());
    }

    @Test
    void gstinLiveVerifyMustBeCompleteBeforeVerification() {
        var app = new VendorKycApplication("01VEND000000000000000005A");
        app.setIdentity(LEGAL_NAME, BusinessType.PRIVATE_LIMITED, PIXOUS_PAN);
        app.setGstin(PIXOUS_GSTIN, false);      // live verify pending
        app.setBankAccount(new BankAccount("50100123456789", "HDFC0001234", LEGAL_NAME),
                new PennyDropResult(true, LEGAL_NAME));
        app.addDocument(new DocumentRef("GST_CERT", "gst.pdf", 500_000));
        app.addCategoryInterest("01CATFASHION00000000000AA");
        app.signAgreement();
        app.submit();
        var pending = assertInstanceOf(Outcome.Rejected.class, app.verify());
        assertTrue(pending.violations().contains("GSTIN_LIVE_VERIFY_PENDING"));
        assertFalse(app.canTransact());
    }

    @Test
    void changingBankOrGstinForcesReKycAndSuspendsTransacting() {
        var app = completeApplication();
        app.submit();
        app.verify();
        assertTrue(app.canTransact());

        // vendor changes bank account → re-KYC
        app.setBankAccount(new BankAccount("50100999999999", "ICIC0004321", LEGAL_NAME),
                new PennyDropResult(true, LEGAL_NAME));
        assertEquals(Status.RE_KYC_REQUIRED, app.status());
        assertFalse(app.canTransact(), "selling is gated until re-verification");

        // re-verify restores it
        assertInstanceOf(Outcome.Ok.class, app.verify());
        assertTrue(app.canTransact());
    }

    @Test
    void unregisteredGstVendorIsRestrictedToExemptCategories() {
        var app = new VendorKycApplication("01VEND000000000000000006A");
        app.setIdentity("Kanchi Weaves", BusinessType.PROPRIETORSHIP, "KBCPK1234E");
        assertTrue(assertInstanceOf(Outcome.Rejected.class, app.declareUnregistered(false))
                .violations().contains("TURNOVER_SELF_DECLARATION_REQUIRED"));
        assertInstanceOf(Outcome.Ok.class, app.declareUnregistered(true));
        app.setBankAccount(new BankAccount("50100123456789", "HDFC0001234", "Kanchi Weaves"),
                new PennyDropResult(true, "KANCHI WEAVES"));
        app.addDocument(new DocumentRef("PAN_CARD", "pan.jpg", 200_000));
        app.addCategoryInterest("01CATEXEMPT000000000000AA");
        app.signAgreement();
        assertInstanceOf(Outcome.Ok.class, app.submit());
        assertInstanceOf(Outcome.Ok.class, app.verify());   // no GSTIN ⇒ no live-verify gate

        assertFalse(app.isGstRegistered());
        Set<String> exempt = Set.of("01CATEXEMPT000000000000AA");
        assertTrue(app.maySellInCategory("01CATEXEMPT000000000000AA", exempt));
        assertFalse(app.maySellInCategory("01CATFASHION00000000000AA", exempt), "non-exempt category blocked");
    }

    @Test
    void registeredVendorMaySellBeyondExemptCategories() {
        var app = completeApplication();
        app.submit();
        app.verify();
        assertTrue(app.maySellInCategory("01CATFASHION00000000000AA", Set.of("01CATEXEMPT000000000000AA")));
    }

    @Test
    void missingPiecesAreReportedTogether() {
        var app = new VendorKycApplication("01VEND000000000000000007A");
        List<String> missing = app.missingForSubmission();
        assertTrue(missing.containsAll(List.of("IDENTITY_MISSING", "PAN_MISSING",
                "BANK_PENNY_DROP_MISSING", "DOCUMENTS_MISSING", "CATEGORY_INTERESTS_MISSING",
                "AGREEMENT_NOT_SIGNED")));
    }
}
