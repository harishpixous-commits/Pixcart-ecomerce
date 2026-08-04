package com.pixous.pixcart.identity.domain.customer;

import com.pixous.pixcart.identity.domain.customer.AddressBook.Address;
import com.pixous.pixcart.identity.domain.customer.AddressBook.Result;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** FR-CUS-005: address book limits, validation and the immutable order-snapshot rule. */
class AddressBookTest {

    private static final Set<String> PIN_MASTER = Set.of("641012", "560001");

    private static Address addr(String id) {
        return new Address(id, "Home", "382 Lakshmanan Nagar", "Gandhipuram",
                "Coimbatore", "TN", "641012", "+919876543210", 11.0, 76.9);
    }

    @Test
    void firstAddressBecomesDefaultAutomatically() {
        var book = new AddressBook();
        assertInstanceOf(Result.Ok.class, book.add(addr("A1"), PIN_MASTER));
        assertEquals("A1", book.defaultAddress().orElseThrow().addressId());
    }

    @Test
    void atMostTenAddresses() {
        var book = new AddressBook();
        for (int i = 1; i <= AddressBook.MAX_ADDRESSES; i++) {
            assertInstanceOf(Result.Ok.class, book.add(addr("A" + i), PIN_MASTER), "add " + i);
        }
        var over = assertInstanceOf(Result.Rejected.class, book.add(addr("A11"), PIN_MASTER));
        assertTrue(over.violations().contains("MAX_ADDRESSES_REACHED"));
        assertEquals(10, book.size());
    }

    @Test
    void validationRules() {
        var book = new AddressBook();
        // line1 too short
        var shortLine = book.add(new Address("B1", "H", "12 A", null, "CBE", "TN", "641012", "+919876543210", null, null), PIN_MASTER);
        assertTrue(assertInstanceOf(Result.Rejected.class, shortLine).violations().contains("LINE1_TOO_SHORT"));
        // PIN not in master
        var badPin = book.add(new Address("B2", "H", "382 Lakshmanan Nagar", null, "X", "TN", "999999", "+919876543210", null, null), PIN_MASTER);
        assertTrue(assertInstanceOf(Result.Rejected.class, badPin).violations().contains("PIN_NOT_IN_MASTER"));
        // malformed PIN
        var malformed = book.add(new Address("B3", "H", "382 Lakshmanan Nagar", null, "X", "TN", "64101", "+919876543210", null, null), PIN_MASTER);
        assertTrue(assertInstanceOf(Result.Rejected.class, malformed).violations().contains("PIN_MALFORMED"));
        // mobile not E.164
        var badMobile = book.add(new Address("B4", "H", "382 Lakshmanan Nagar", null, "X", "TN", "641012", "9876543210", null, null), PIN_MASTER);
        assertTrue(assertInstanceOf(Result.Rejected.class, badMobile).violations().contains("MOBILE_NOT_E164"));
        // URL in free text
        var url = book.add(new Address("B5", "visit www.spam.com", "382 Lakshmanan Nagar", null, "X", "TN", "641012", "+919876543210", null, null), PIN_MASTER);
        assertTrue(assertInstanceOf(Result.Rejected.class, url).violations().contains("URL_IN_FREE_TEXT"));
        assertEquals(0, book.size(), "no invalid address was stored");
    }

    @Test
    void deletingTheDefaultPromotesAnotherEntry() {
        var book = new AddressBook();
        book.add(addr("A1"), PIN_MASTER);
        book.add(addr("A2"), PIN_MASTER);
        assertEquals("A1", book.defaultAddress().orElseThrow().addressId());
        assertTrue(book.delete("A1"));
        assertEquals("A2", book.defaultAddress().orElseThrow().addressId());
    }

    @Test
    void setDefaultOnlyWorksForAnExistingEntry() {
        var book = new AddressBook();
        book.add(addr("A1"), PIN_MASTER);
        assertFalse(book.setDefault("NOPE"));
        book.add(addr("A2"), PIN_MASTER);
        assertTrue(book.setDefault("A2"));
        assertEquals("A2", book.defaultAddress().orElseThrow().addressId());
    }

    // ------------------------------------------------- the snapshot rule

    @Test
    void editingTheAddressAfterAnOrderDoesNotMutateTheSnapshot() {
        var book = new AddressBook();
        book.add(addr("A1"), PIN_MASTER);
        var snap = book.snapshotFor("A1", 1_784_800_000_000L).orElseThrow();
        assertEquals("382 Lakshmanan Nagar", snap.line1());

        // customer moves house and edits the entry
        book.update(new Address("A1", "Home", "99 New Street", "Peelamedu",
                "Coimbatore", "TN", "560001", "+919999999999", null, null), PIN_MASTER);

        // the ORDER's snapshot is untouched (RULES: never mutates historical orders)
        assertEquals("382 Lakshmanan Nagar", snap.line1());
        assertEquals("641012", snap.pin());
        assertEquals("+919876543210", snap.mobileE164());
        // while the live book entry reflects the change
        assertEquals("99 New Street", book.find("A1").orElseThrow().line1());
    }

    @Test
    void deletingTheAddressAfterAnOrderDoesNotMutateTheSnapshot() {
        var book = new AddressBook();
        book.add(addr("A1"), PIN_MASTER);
        var snap = book.snapshotFor("A1", 1_784_800_000_000L).orElseThrow();
        assertTrue(book.delete("A1"));
        assertTrue(book.find("A1").isEmpty(), "entry gone from the book");
        // the snapshot still carries the full delivery address for the historical order
        assertEquals("A1", snap.sourceAddressId());
        assertEquals("382 Lakshmanan Nagar", snap.line1());
        assertEquals("Coimbatore", snap.city());
    }

    @Test
    void snapshotOfAnUnknownAddressIsEmpty() {
        assertTrue(new AddressBook().snapshotFor("NOPE", 0L).isEmpty());
    }
}
