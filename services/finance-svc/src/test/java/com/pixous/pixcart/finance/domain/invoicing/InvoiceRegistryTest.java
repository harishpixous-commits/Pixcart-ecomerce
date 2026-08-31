package com.pixous.pixcart.finance.domain.invoicing;

import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.Document;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.DocumentType;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.IrnResult;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.IrnState;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.IssueResult;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.Line;
import com.pixous.pixcart.finance.domain.invoicing.InvoiceRegistry.SeriesConfig;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** FR-FIN-003, with the documented 1-of-3 partial-return acceptance scenario encoded verbatim. */
class InvoiceRegistryTest {

    private static final Instant AUG_2026 = Instant.parse("2026-08-15T10:00:00Z");
    private static final String PIXOUS_GSTIN = "33AAMCP3151E1ZO";

    private static InvoiceRegistry registry(boolean eInvoice) {
        return new InvoiceRegistry().configureSeries(
                new SeriesConfig("01VEND1", "PIX/KW", PIXOUS_GSTIN, eInvoice));
    }

    /** 3 units at ₹1000 taxable each: taxable 3000, CGST 270 + SGST 270 at 18%. */
    private static Line threeUnits() {
        return new Line("L1", "Kanchipuram Silk Saree", "50079010", 3,
                3_000_00, 270_00, 270_00, 0);
    }

    private static Document ok(IssueResult r) {
        if (r instanceof IssueResult.Rejected rej) throw new AssertionError("rejected: " + rej.violations());
        return ((IssueResult.Ok) r).document();
    }

    // -------------------------------------------------- numbering & fields

    @Test
    void financialYearFollowsTheIndianAprilToMarchBoundary() {
        assertEquals("26-27", InvoiceRegistry.financialYearLabel(Instant.parse("2026-08-15T10:00:00Z")));
        assertEquals("26-27", InvoiceRegistry.financialYearLabel(Instant.parse("2026-04-01T00:00:00Z")));
        assertEquals("25-26", InvoiceRegistry.financialYearLabel(Instant.parse("2026-03-31T10:00:00Z")));
        // 2026-04-01T00:00Z is 05:30 IST on 1 April, so still FY 26-27
        assertEquals("25-26", InvoiceRegistry.financialYearLabel(Instant.parse("2026-03-31T18:00:00Z")));
    }

    @Test
    void numbersAreSequentialPerVendorAndFinancialYear() {
        var r = registry(false);
        var a = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        var b = ok(r.issueInvoice("SUB-2", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertEquals("PIX/KW/26-27/000001", a.number());
        assertEquals("PIX/KW/26-27/000002", b.number());
        assertEquals(List.of(1, 2), r.sequencesIn(InvoiceRegistry.seriesKey("01VEND1", AUG_2026)));

        // a new financial year restarts the series
        Instant nextFy = Instant.parse("2027-05-01T10:00:00Z");
        var c = ok(r.issueInvoice("SUB-3", "01VEND1", null, "33", List.of(threeUnits()), nextFy));
        assertEquals("PIX/KW/27-28/000001", c.number());
    }

    @Test
    void aRejectedInvoiceConsumesNoNumber_soTheSeriesHasNoGaps() {
        var r = registry(false);
        ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));

        // three rejected attempts for different reasons
        assertInstanceOf(IssueResult.Rejected.class,
                r.issueInvoice("SUB-2", "01VEND1", null, "3", List.of(threeUnits()), AUG_2026));      // bad state code
        assertInstanceOf(IssueResult.Rejected.class,
                r.issueInvoice("SUB-2", "01VEND1", null, "33", List.of(), AUG_2026));                 // no lines
        assertInstanceOf(IssueResult.Rejected.class,
                r.issueInvoice("SUB-2", "01VEND-UNKNOWN", null, "33", List.of(threeUnits()), AUG_2026));

        var next = ok(r.issueInvoice("SUB-2", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertEquals("PIX/KW/26-27/000002", next.number(), "the next good invoice is 2, not 5");
        assertEquals(List.of(1, 2), r.sequencesIn(InvoiceRegistry.seriesKey("01VEND1", AUG_2026)));
    }

    @Test
    void mandatoryGstFieldsAreEnforced() {
        var r = registry(false);
        var noPos = assertInstanceOf(IssueResult.Rejected.class,
                r.issueInvoice("SUB-1", "01VEND1", null, null, List.of(threeUnits()), AUG_2026));
        assertTrue(noPos.violations().contains("PLACE_OF_SUPPLY_STATE_CODE_REQUIRED"));

        var badGstin = assertInstanceOf(IssueResult.Rejected.class,
                r.issueInvoice("SUB-1", "01VEND1", "TOO-SHORT", "33", List.of(threeUnits()), AUG_2026));
        assertTrue(badGstin.violations().contains("RECIPIENT_GSTIN_MALFORMED"));

        // HSN is mandatory at the line level — the line itself is unconstructible without it
        assertThrows(IllegalArgumentException.class,
                () -> new Line("L1", "x", "", 1, 100, 9, 9, 0));
        // and a line cannot carry both intra-state and inter-state tax
        assertThrows(IllegalArgumentException.class,
                () -> new Line("L1", "x", "50079010", 1, 100, 9, 9, 18));
    }

    @Test
    void b2cInvoiceNeedsNoRecipientGstinAndB2bKeepsIt() {
        var r = registry(false);
        assertNull(ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026)).recipientGstin());
        assertNull(ok(r.issueInvoice("SUB-2", "01VEND1", "  ", "33", List.of(threeUnits()), AUG_2026)).recipientGstin());
        assertEquals("29AABCU9603R1ZM",
                ok(r.issueInvoice("SUB-3", "01VEND1", "29AABCU9603R1ZM", "29", List.of(threeUnits()), AUG_2026))
                        .recipientGstin());
    }

    // -------------------------------------------------- the acceptance scenario

    @Test
    void partialReturnOfOneOfThreeUnits_acceptanceScenario() {
        // "Given a partial return of 1 of 3 units, When credit note generates, Then it references
        //  the original invoice number, carries proportional tax reversal, and the customer
        //  document set shows both PDFs."
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));

        var note = ok(r.issueCreditNote(invoice.number(), Map.of("L1", 1), AUG_2026.plus(Duration.ofDays(3))));

        assertEquals(DocumentType.CREDIT_NOTE, note.type());
        assertEquals(invoice.number(), note.originalNumber(), "the note references the original");

        // proportional reversal: one third of taxable 3000.00 and of each 270.00 tax component
        Line cl = note.lines().get(0);
        assertEquals(1, cl.quantity());
        assertEquals(1_000_00, cl.taxableValuePaise());
        assertEquals(90_00, cl.cgstPaise());
        assertEquals(90_00, cl.sgstPaise());
        assertEquals(0, cl.igstPaise());
        assertEquals(1_180_00, cl.grossPaise());

        // the customer's document set holds both documents
        var set = r.documentSetFor("SUB-1");
        assertEquals(2, set.size());
        assertTrue(set.stream().anyMatch(d -> d.type() == DocumentType.TAX_INVOICE));
        assertTrue(set.stream().anyMatch(d -> d.type() == DocumentType.CREDIT_NOTE));
    }

    @Test
    void successivePartialCreditNotesSumToExactlyTheOriginal_noPaisaLeak() {
        // A taxable amount that does NOT divide evenly by 3 — the case where naive independent
        // rounding leaks or creates a paisa.
        var r = registry(false);
        Line awkward = new Line("L1", "Item", "50079010", 3, 1_000_01, 90_00, 90_01, 0);
        var invoice = ok(r.issueInvoice("SUB-9", "01VEND1", null, "33", List.of(awkward), AUG_2026));

        long taxable = 0, cgst = 0, sgst = 0;
        for (int i = 0; i < 3; i++) {
            var note = ok(r.issueCreditNote(invoice.number(), Map.of("L1", 1),
                    AUG_2026.plus(Duration.ofDays(i + 1))));
            Line cl = note.lines().get(0);
            taxable += cl.taxableValuePaise();
            cgst += cl.cgstPaise();
            sgst += cl.sgstPaise();
        }
        assertEquals(awkward.taxableValuePaise(), taxable, "taxable reversals must sum exactly");
        assertEquals(awkward.cgstPaise(), cgst, "CGST reversals must sum exactly");
        assertEquals(awkward.sgstPaise(), sgst, "SGST reversals must sum exactly");
    }

    @Test
    void aSingleFullReturnReversesTheWholeInvoiceExactly() {
        var r = registry(false);
        Line awkward = new Line("L1", "Item", "50079010", 7, 999_99, 89_99, 90_01, 0);
        var invoice = ok(r.issueInvoice("SUB-8", "01VEND1", null, "33", List.of(awkward), AUG_2026));
        var note = ok(r.issueCreditNote(invoice.number(), Map.of("L1", 7), AUG_2026));
        assertEquals(invoice.taxableTotalPaise(), note.taxableTotalPaise());
        assertEquals(invoice.taxTotalPaise(), note.taxTotalPaise());
        assertEquals(invoice.grossTotalPaise(), note.grossTotalPaise());
    }

    @Test
    void creditingMoreThanWasInvoicedIsRefused() {
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        ok(r.issueCreditNote(invoice.number(), Map.of("L1", 2), AUG_2026));
        var over = assertInstanceOf(IssueResult.Rejected.class,
                r.issueCreditNote(invoice.number(), Map.of("L1", 2), AUG_2026));
        assertTrue(over.violations().stream().anyMatch(x -> x.startsWith("RETURN_EXCEEDS_INVOICED_QUANTITY")));
        // the remaining single unit is still creditable
        assertInstanceOf(IssueResult.Ok.class, r.issueCreditNote(invoice.number(), Map.of("L1", 1), AUG_2026));
    }

    @Test
    void creditNoteAgainstAnUnknownOrAbsentLineIsRefused() {
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertInstanceOf(IssueResult.Rejected.class, r.issueCreditNote("NO/SUCH/NUMBER", Map.of("L1", 1), AUG_2026));
        var badLine = assertInstanceOf(IssueResult.Rejected.class,
                r.issueCreditNote(invoice.number(), Map.of("L9", 1), AUG_2026));
        assertTrue(badLine.violations().stream().anyMatch(x -> x.startsWith("LINE_NOT_ON_ORIGINAL")));
        assertInstanceOf(IssueResult.Rejected.class, r.issueCreditNote(invoice.number(), Map.of(), AUG_2026));
        var zero = assertInstanceOf(IssueResult.Rejected.class,
                r.issueCreditNote(invoice.number(), Map.of("L1", 0), AUG_2026));
        assertTrue(zero.violations().stream().anyMatch(x -> x.startsWith("RETURN_QUANTITY_MUST_BE_POSITIVE")));
    }

    @Test
    void aCreditNoteCannotBeCreditedAgain() {
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        var note = ok(r.issueCreditNote(invoice.number(), Map.of("L1", 1), AUG_2026));
        var r2 = assertInstanceOf(IssueResult.Rejected.class,
                r.issueCreditNote(note.number(), Map.of("L1", 1), AUG_2026));
        assertTrue(r2.violations().contains("ORIGINAL_MUST_BE_A_TAX_INVOICE"));
    }

    // -------------------------------------------------- immutability & hash

    @Test
    void issuedDocumentsCarryATamperHashAndExposeNoMutator() {
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertEquals(64, invoice.tamperHash().length());
        assertTrue(invoice.isIntact());

        // no setter exists for any content field — corrections happen only via credit notes
        var mutators = java.util.Arrays.stream(Document.class.getMethods())
                .map(java.lang.reflect.Method::getName)
                .filter(n -> n.startsWith("set") || n.equals("amend") || n.equals("update"))
                .toList();
        assertTrue(mutators.isEmpty(), "issued documents must be immutable, found: " + mutators);

        // two invoices with identical content but different numbers hash differently
        var other = ok(r.issueInvoice("SUB-2", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertNotEquals(invoice.tamperHash(), other.tamperHash());
    }

    // -------------------------------------------------- e-invoice lifecycle

    @Test
    void eInvoiceStartsPendingIrnAndAlertsAtTwentyHours() {
        var r = registry(true);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertEquals(IrnState.PENDING_IRN, invoice.irnState(), "GSP down: issued without IRN");
        assertFalse(r.needsPendingIrnAlert(invoice.number(), AUG_2026.plus(Duration.ofHours(19))));
        assertTrue(r.needsPendingIrnAlert(invoice.number(), AUG_2026.plus(Duration.ofHours(21))));

        assertInstanceOf(IrnResult.Ok.class,
                r.attachIrn(invoice.number(), "IRN1234567890ABCDEF", AUG_2026.plus(Duration.ofHours(2))));
        assertEquals(IrnState.ISSUED, invoice.irnState());
        assertFalse(r.needsPendingIrnAlert(invoice.number(), AUG_2026.plus(Duration.ofHours(30))));
        // a second attach is refused
        assertInstanceOf(IrnResult.Rejected.class,
                r.attachIrn(invoice.number(), "IRN9999999999ZZZZZZ", AUG_2026.plus(Duration.ofHours(3))));
    }

    @Test
    void nonEInvoiceVendorsGetNoIrnState() {
        var r = registry(false);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        assertEquals(IrnState.NOT_APPLICABLE, invoice.irnState());
        assertInstanceOf(IrnResult.Rejected.class, r.attachIrn(invoice.number(), "IRN1234567890", AUG_2026));
    }

    @Test
    void irnCancellationHonoursThe24HourWindowThenDirectsToACreditNote() {
        var r = registry(true);
        var invoice = ok(r.issueInvoice("SUB-1", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        Instant irnAt = AUG_2026.plus(Duration.ofHours(1));
        r.attachIrn(invoice.number(), "IRN1234567890ABCDEF", irnAt);

        assertInstanceOf(IrnResult.Ok.class, r.cancelIrn(invoice.number(), irnAt.plus(Duration.ofHours(23))));
        assertEquals(IrnState.CANCELLED, invoice.irnState());

        // past the window, cancellation is refused and the caller is pointed at a credit note
        var r2 = registry(true);
        var inv2 = ok(r2.issueInvoice("SUB-2", "01VEND1", null, "33", List.of(threeUnits()), AUG_2026));
        r2.attachIrn(inv2.number(), "IRN1234567890ABCDEF", irnAt);
        var late = assertInstanceOf(IrnResult.Rejected.class,
                r2.cancelIrn(inv2.number(), irnAt.plus(Duration.ofHours(25))));
        assertTrue(late.reason().contains("USE_CREDIT_NOTE"));
    }

    @Test
    void proportionHelperRoundsHalfUpAndIsExactAtTheEnds() {
        assertEquals(0, InvoiceRegistry.proportion(1000, 3, 0));
        assertEquals(1000, InvoiceRegistry.proportion(1000, 3, 3));
        assertEquals(1000, InvoiceRegistry.proportion(1000, 3, 5), "n beyond quantity is capped");
        assertEquals(333, InvoiceRegistry.proportion(1000, 3, 1));
        assertEquals(667, InvoiceRegistry.proportion(1000, 3, 2));
        // the deltas of a full sweep reconstruct the total exactly
        long sum = 0;
        for (int i = 1; i <= 3; i++) sum += InvoiceRegistry.delta(1000, 3, i - 1, i);
        assertEquals(1000, sum);
    }
}
