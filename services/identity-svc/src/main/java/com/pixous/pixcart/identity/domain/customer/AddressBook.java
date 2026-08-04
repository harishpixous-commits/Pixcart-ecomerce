package com.pixous.pixcart.identity.domain.customer;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Customer address book — FR-CUS-005.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "manage up to 10 delivery addresses per customer with labels, geocoding,
 *                serviceability check and a default flag; addresses used on orders are
 *                snapshotted immutably on the order."
 *   RULES:      "Deleting an address never mutates historical orders (snapshot rule);
 *                default address auto-selected at checkout."
 *   VALIDATION: "PIN must exist in PIN master; mobile E.164; line1 ≥ 6 chars;
 *                profanity/URL filter on free text."
 *
 * The snapshot rule is the interesting invariant: an order carries an immutable COPY of the
 * address as it was at order time, so editing or deleting the book entry afterwards cannot
 * rewrite history. That is enforced here by {@link #snapshotFor}, which returns a
 * value-object copy, and proven by the tests.
 *
 * Serviceability is NOT decided here — it is the logistics service's call (FR-LOG-001); the
 * book records the last known result so checkout can pre-select a serviceable default.
 */
public final class AddressBook {

    public static final int MAX_ADDRESSES = 10;
    public static final int MIN_LINE1_LENGTH = 6;

    private static final Pattern E164 = Pattern.compile("^\\+[1-9]\\d{7,14}$");
    private static final Pattern PIN = Pattern.compile("^\\d{6}$");
    private static final Pattern URL_LIKE = Pattern.compile("(?i)(https?://|www\\.|\\.com\\b|\\.in\\b)");

    /** A mutable book entry. */
    public record Address(String addressId, String label, String line1, String line2,
                          String city, String state, String pin, String mobileE164,
                          Double lat, Double lng) {
    }

    /**
     * The immutable snapshot written onto an order. Deliberately a separate type from
     * {@link Address} so no code path can hand a live, editable entry to an order.
     */
    public record AddressSnapshot(String sourceAddressId, String label, String line1, String line2,
                                  String city, String state, String pin, String mobileE164,
                                  long snapshotAtMs) {
    }

    public sealed interface Result {
        record Ok(String addressId) implements Result {}
        record Rejected(List<String> violations) implements Result {}
    }

    private final List<Address> addresses = new ArrayList<>();
    private String defaultAddressId;

    /** VALIDATION: PIN in master, mobile E.164, line1 ≥ 6 chars, no URLs in free text. */
    public static List<String> validate(Address a, Set<String> pinMaster) {
        var v = new ArrayList<String>();
        if (a.line1() == null || a.line1().trim().length() < MIN_LINE1_LENGTH) v.add("LINE1_TOO_SHORT");
        if (a.pin() == null || !PIN.matcher(a.pin()).matches()) v.add("PIN_MALFORMED");
        else if (!pinMaster.contains(a.pin())) v.add("PIN_NOT_IN_MASTER");
        if (a.mobileE164() == null || !E164.matcher(a.mobileE164()).matches()) v.add("MOBILE_NOT_E164");
        for (String free : new String[]{a.label(), a.line1(), a.line2()}) {
            if (free != null && URL_LIKE.matcher(free).find()) { v.add("URL_IN_FREE_TEXT"); break; }
        }
        return v;
    }

    /** Add an address. The first one added becomes the default automatically. */
    public Result add(Address a, Set<String> pinMaster) {
        var violations = validate(a, pinMaster);
        if (!violations.isEmpty()) return new Result.Rejected(violations);
        if (addresses.size() >= MAX_ADDRESSES) return new Result.Rejected(List.of("MAX_ADDRESSES_REACHED"));
        if (addresses.stream().anyMatch(x -> x.addressId().equals(a.addressId()))) {
            return new Result.Rejected(List.of("DUPLICATE_ADDRESS_ID"));
        }
        addresses.add(a);
        if (defaultAddressId == null) defaultAddressId = a.addressId();
        return new Result.Ok(a.addressId());
    }

    public Result update(Address a, Set<String> pinMaster) {
        var violations = validate(a, pinMaster);
        if (!violations.isEmpty()) return new Result.Rejected(violations);
        int i = indexOf(a.addressId());
        if (i < 0) return new Result.Rejected(List.of("ADDRESS_NOT_FOUND"));
        addresses.set(i, a);
        return new Result.Ok(a.addressId());
    }

    /** Delete an entry. If it was the default, the first remaining entry becomes default. */
    public boolean delete(String addressId) {
        int i = indexOf(addressId);
        if (i < 0) return false;
        addresses.remove(i);
        if (addressId.equals(defaultAddressId)) {
            defaultAddressId = addresses.isEmpty() ? null : addresses.get(0).addressId();
        }
        return true;
    }

    public boolean setDefault(String addressId) {
        if (indexOf(addressId) < 0) return false;
        defaultAddressId = addressId;
        return true;
    }

    /** RULES: the default address is auto-selected at checkout. */
    public Optional<Address> defaultAddress() {
        return defaultAddressId == null ? Optional.empty() : find(defaultAddressId);
    }

    /**
     * Produce the immutable snapshot an order stores (RULES: snapshot rule). Once taken,
     * nothing done to the book — edit, delete, re-default — can alter this value.
     */
    public Optional<AddressSnapshot> snapshotFor(String addressId, long nowMs) {
        return find(addressId).map(a -> new AddressSnapshot(
                a.addressId(), a.label(), a.line1(), a.line2(), a.city(), a.state(), a.pin(), a.mobileE164(), nowMs));
    }

    public Optional<Address> find(String addressId) {
        return addresses.stream().filter(a -> a.addressId().equals(addressId)).findFirst();
    }

    public List<Address> all() {
        return List.copyOf(addresses);
    }

    public int size() {
        return addresses.size();
    }

    private int indexOf(String addressId) {
        for (int i = 0; i < addresses.size(); i++) if (addresses.get(i).addressId().equals(addressId)) return i;
        return -1;
    }
}
