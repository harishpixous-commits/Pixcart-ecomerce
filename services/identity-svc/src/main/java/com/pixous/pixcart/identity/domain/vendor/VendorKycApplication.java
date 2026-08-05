package com.pixous.pixcart.identity.domain.vendor;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Vendor registration & KYC — FR-VEN-001.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:   "onboard vendors through a wizard capturing business identity (legal name,
 *            type), GSTIN/PAN, bank account (penny-drop verified), pickup address, category
 *            interests and agreement e-sign, producing a verifiable KYC pack."
 *   RULES:  "BRU-01 gates selling; unregistered-GST vendors restricted to exempt categories
 *            with turnover self-declaration; re-KYC triggered on bank/GSTIN change."
 *   BRU-01: "A vendor may transact only after KYC verification, bank-account penny-drop
 *            validation and signed marketplace agreement."
 *
 * The aggregate accumulates wizard input and answers one question authoritatively:
 * {@link #canTransact()} — the BRU-01 gate. All three conditions must hold together, so a
 * vendor with a verified GSTIN but no penny-drop, or with both but no signed agreement,
 * cannot sell. Changing the bank account or GSTIN revokes verification and forces re-KYC.
 */
public final class VendorKycApplication {

    public enum BusinessType { PROPRIETORSHIP, PARTNERSHIP, LLP, PRIVATE_LIMITED, PUBLIC_LIMITED, HUF, TRUST }

    public enum Status { DRAFT, SUBMITTED, VERIFIED, REJECTED, RE_KYC_REQUIRED }

    /** Facts returned by external providers; the domain never fabricates them. */
    public record PennyDropResult(boolean credited, String accountHolderName) {}

    public record BankAccount(String accountNumber, String ifsc, String holderNameDeclared) {}

    private final String vendorId;
    private String legalName;
    private BusinessType businessType;
    private String gstin;                  // null ⇒ unregistered (exempt categories only)
    private String pan;
    private BankAccount bank;
    private boolean pennyDropVerified;
    private boolean agreementSigned;
    private boolean gstinLiveVerified;     // provider fact
    private boolean turnoverSelfDeclared;  // required when unregistered
    private final Set<String> categoryInterests = new LinkedHashSet<>();
    private final List<KycValidators.DocumentRef> documents = new ArrayList<>();
    private Status status = Status.DRAFT;

    public VendorKycApplication(String vendorId) {
        if (vendorId == null || vendorId.isBlank()) throw new IllegalArgumentException("vendorId");
        this.vendorId = vendorId;
    }

    public sealed interface Outcome {
        record Ok() implements Outcome {}
        record Rejected(List<String> violations) implements Outcome {}
    }

    public Outcome setIdentity(String legalName, BusinessType type, String pan) {
        var v = new ArrayList<String>();
        if (legalName == null || legalName.trim().length() < 3) v.add("LEGAL_NAME_TOO_SHORT");
        if (type == null) v.add("BUSINESS_TYPE_REQUIRED");
        if (!KycValidators.isPanWellFormed(pan)) v.add("PAN_MALFORMED");
        else if (!KycValidators.panInitialMatchesName(pan, legalName)) v.add("PAN_NAME_INITIAL_MISMATCH");
        if (!v.isEmpty()) return new Outcome.Rejected(v);
        this.legalName = legalName;
        this.businessType = type;
        this.pan = pan.toUpperCase();
        return new Outcome.Ok();
    }

    /**
     * Register a GSTIN. Structure, state code and check digit are validated offline; the
     * embedded PAN must equal the declared PAN. `liveVerified` is the provider's answer.
     */
    public Outcome setGstin(String gstin, boolean liveVerified) {
        var v = new ArrayList<String>();
        if (!KycValidators.isGstinWellFormed(gstin)) v.add("GSTIN_INVALID_OR_CHECKSUM_FAILED");
        else if (pan != null && !KycValidators.panFromGstin(gstin).equals(pan)) v.add("GSTIN_PAN_MISMATCH");
        if (!v.isEmpty()) return new Outcome.Rejected(v);

        boolean changed = this.gstin != null && !this.gstin.equalsIgnoreCase(gstin);
        this.gstin = gstin.toUpperCase();
        this.gstinLiveVerified = liveVerified;
        if (changed) requireReKyc();          // RULES: re-KYC on GSTIN change
        return new Outcome.Ok();
    }

    /** Declare unregistered-GST status; requires a turnover self-declaration (RULES). */
    public Outcome declareUnregistered(boolean turnoverSelfDeclared) {
        if (!turnoverSelfDeclared) return new Outcome.Rejected(List.of("TURNOVER_SELF_DECLARATION_REQUIRED"));
        this.gstin = null;
        this.gstinLiveVerified = false;
        this.turnoverSelfDeclared = true;
        return new Outcome.Ok();
    }

    /**
     * Set the bank account and apply the penny-drop result. The credited flag alone is not
     * enough — the returned holder name must match the declared name ≥ 0.8 (VALIDATION).
     */
    public Outcome setBankAccount(BankAccount account, PennyDropResult drop) {
        var v = new ArrayList<String>();
        if (account == null) return new Outcome.Rejected(List.of("BANK_ACCOUNT_REQUIRED"));
        if (account.accountNumber() == null || account.accountNumber().length() < 6) v.add("ACCOUNT_NUMBER_INVALID");
        if (!KycValidators.isIfscWellFormed(account.ifsc())) v.add("IFSC_MALFORMED");
        if (drop == null || !drop.credited()) v.add("PENNY_DROP_FAILED");
        else if (!KycValidators.namesMatch(drop.accountHolderName(), account.holderNameDeclared())) {
            v.add("PENNY_DROP_NAME_MISMATCH");
        }
        if (!v.isEmpty()) return new Outcome.Rejected(v);

        boolean changed = this.bank != null && !this.bank.accountNumber().equals(account.accountNumber());
        this.bank = account;
        this.pennyDropVerified = true;
        if (changed) requireReKyc();          // RULES: re-KYC on bank change
        return new Outcome.Ok();
    }

    public Outcome addDocument(KycValidators.DocumentRef doc) {
        var check = KycValidators.checkDocument(doc);
        if (check instanceof KycValidators.DocCheck.Rejected r) return new Outcome.Rejected(List.of(r.reason()));
        documents.add(doc);
        return new Outcome.Ok();
    }

    public void signAgreement() {
        this.agreementSigned = true;
    }

    public void addCategoryInterest(String categoryId) {
        categoryInterests.add(categoryId);
    }

    /** Submit for verification; the pack must be complete first. */
    public Outcome submit() {
        var missing = missingForSubmission();
        if (!missing.isEmpty()) return new Outcome.Rejected(missing);
        this.status = Status.SUBMITTED;
        return new Outcome.Ok();
    }

    public List<String> missingForSubmission() {
        var m = new ArrayList<String>();
        if (legalName == null) m.add("IDENTITY_MISSING");
        if (pan == null) m.add("PAN_MISSING");
        if (gstin == null && !turnoverSelfDeclared) m.add("GSTIN_OR_UNREGISTERED_DECLARATION_MISSING");
        if (bank == null || !pennyDropVerified) m.add("BANK_PENNY_DROP_MISSING");
        if (documents.isEmpty()) m.add("DOCUMENTS_MISSING");
        if (categoryInterests.isEmpty()) m.add("CATEGORY_INTERESTS_MISSING");
        if (!agreementSigned) m.add("AGREEMENT_NOT_SIGNED");
        return m;
    }

    /** Admin verification decision (after live GSTIN verify and document review). */
    public Outcome verify() {
        if (status != Status.SUBMITTED && status != Status.RE_KYC_REQUIRED) {
            return new Outcome.Rejected(List.of("NOT_SUBMITTED"));
        }
        if (gstin != null && !gstinLiveVerified) return new Outcome.Rejected(List.of("GSTIN_LIVE_VERIFY_PENDING"));
        this.status = Status.VERIFIED;
        return new Outcome.Ok();
    }

    public void reject() {
        this.status = Status.REJECTED;
    }

    private void requireReKyc() {
        if (status == Status.VERIFIED) status = Status.RE_KYC_REQUIRED;
    }

    /**
     * BRU-01 gate: a vendor may transact only with KYC verified AND penny-drop validated
     * AND a signed marketplace agreement. All three, together.
     */
    public boolean canTransact() {
        return status == Status.VERIFIED && pennyDropVerified && agreementSigned;
    }

    /**
     * RULES: unregistered-GST vendors are restricted to exempt categories. Registered
     * vendors may sell in any category they are approved for.
     */
    public boolean maySellInCategory(String categoryId, Set<String> exemptCategoryIds) {
        if (!canTransact()) return false;
        if (gstin != null) return true;
        return exemptCategoryIds.contains(categoryId);
    }

    public boolean isGstRegistered()  { return gstin != null; }
    public Status status()            { return status; }
    public String vendorId()          { return vendorId; }
    public boolean pennyDropVerified(){ return pennyDropVerified; }
    public boolean agreementSigned()  { return agreementSigned; }
    public Set<String> categoryInterests() { return Set.copyOf(categoryInterests); }
    public List<KycValidators.DocumentRef> documents() { return List.copyOf(documents); }
}
