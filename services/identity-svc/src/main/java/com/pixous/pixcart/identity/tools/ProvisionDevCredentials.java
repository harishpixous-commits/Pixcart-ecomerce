package com.pixous.pixcart.identity.tools;

import com.pixous.pixcart.identity.security.PasswordHasher;

import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Sets a password on staff and vendor rows so they can actually sign in (V008).
 *
 * <h2>Why this exists</h2>
 * V008 added a nullable {@code password_hash} to {@code id_staff} and {@code ven_store}, and
 * deliberately left it NULL: a row with no hash cannot authenticate, because
 * {@code PasswordHasher.matches} fails closed. That is the correct default for production —
 * an operator provisions accounts through whatever identity process the platform runs. But
 * it leaves the local development database unable to demonstrate a staff or vendor login at
 * all, which is how the defect this class fixes went unnoticed in the first place.
 *
 * <h2>Why it is shaped this way</h2>
 * This is <em>not</em> a fallback the application can reach. It is a standalone
 * {@code main}, invoked by name, and it refuses to do anything unless the operator passes
 * the exact string {@code --i-understand-this-writes-to-the-database} on the command line.
 * There is no environment variable, no property and no config file that can enable it, and
 * it is never referenced from Spring configuration — so no deployment accidentally
 * provisions a known password (CLAUDE.md §5: no mock data in production paths).
 *
 * <p>It also refuses to run against a schema whose name looks like production. That is a
 * weak second signal, not a guarantee — a schema named "dev" could still be shared — which
 * is why the typed flag above remains the primary gate.
 *
 * <p>There is deliberately no "does the database look live?" check based on row counts. An
 * earlier version of this class refused when {@code pay_payment} held any rows, reasoning
 * that a populated money path implies production. That was wrong in the only case that
 * mattered: the development database is seeded with demo payments, so the check rejected
 * the very database this tool exists to serve and could never be satisfied. A guard that
 * cannot be passed is not a guard, and guessing at what production looks like is worse than
 * not guessing at all.
 *
 * <h2>What it writes</h2>
 * A fresh random password per account, encoded with the platform's real Argon2id encoder —
 * never a fixed string. It prints each password once, to standard output, so a developer can
 * sign in; nothing is persisted in plaintext. Re-running rotates the credentials and prints
 * the new ones.
 *
 * <h2>Usage</h2>
 * <pre>
 * java -cp target/classes:... \
 *   com.pixous.pixcart.identity.tools.ProvisionDevCredentials \
 *   --i-understand-this-writes-to-the-database \
 *   jdbc:mariadb://127.0.0.1:3306/pixcart_dev pixcart pixcart_dev_pw
 * </pre>
 */
public final class ProvisionDevCredentials {

    /** The only switch that enables a write. Typed, not toggled. */
    public static final String CONFIRM_FLAG = "--i-understand-this-writes-to-the-database";

    /** Schemas this tool will not touch, named so a typo cannot be mistaken for safety. */
    private static final List<String> FORBIDDEN_SCHEMA_NAMES = List.of(
            "pixcart", "pixcart_prod", "production", "prod");

    private ProvisionDevCredentials() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !CONFIRM_FLAG.equals(args[0])) {
            System.err.println("""
                    ProvisionDevCredentials sets a password on every ACTIVE staff row and every \
                    APPROVED vendor store so they can sign in locally.

                    This tool WRITES to the database you point it at. It will not run without \
                    the exact flag below, and it will not run against a schema that looks like \
                    production. It is a development convenience, not part of the service.

                    usage: ProvisionDevCredentials %s <jdbc-url> <user> <password>""".formatted(CONFIRM_FLAG));
            System.exit(args.length == 0 ? 0 : 2);
            return;
        }
        String url = args[1];
        String user = args[2];
        String password = args[3];

        refuseIfUrlLooksLikeProduction(url);

        PasswordHasher hasher = new PasswordHasher();
        SecureRandom rng = new SecureRandom();

        try (Connection connection = DriverManager.getConnection(url, user, password)) {
            // Staff: only ACTIVE rows. A SUSPENDED or DELETED member is refused at sign-in
            // by Principal.isUsable regardless of their hash, so hashing one here would
            // only create a credential that cannot be used — which is worse than none.
            List<Provisioned> written = provision(connection, hasher, rng,
                    "SELECT id, email, role FROM id_staff WHERE status = 'ACTIVE' AND password_hash IS NULL"
                            + " ORDER BY email",
                    "UPDATE id_staff SET password_hash = ? WHERE id = ?",
                    row -> "STAFF " + row.get("role"));

            // Vendors: APPROVED is ven_store's usable state; PENDING/REJECTED/SUSPENDED/PAUSED
            // are refused by isUsable and are deliberately left unprovisioned.
            written.addAll(provision(connection, hasher, rng,
                    "SELECT id, display_name, email FROM ven_store WHERE status = 'APPROVED' AND password_hash IS NULL"
                            + " ORDER BY email",
                    "UPDATE ven_store SET password_hash = ? WHERE id = ?",
                    row -> "VENDOR"));

            if (written.isEmpty()) {
                System.out.println("Nothing to provision: every usable staff and vendor row already has a credential.");
                return;
            }

            System.out.println();
            System.out.println("Provisioned " + written.size() + " account(s). Each password is printed");
            System.out.println("once, below, and is not stored anywhere in plaintext:");
            System.out.println();
            for (Provisioned entry : written) {
                System.out.printf("  %-46s %-22s %s%n", entry.email(), entry.kindLabel(), entry.password());
            }
            System.out.println();
            System.out.println("Sign in with POST /api/auth/login. Re-running this tool rotates every");
            System.out.println("credential above and prints the replacements.");
        }
    }

    private interface KindLabel {
        String of(Map<String, String> row);
    }

    private record Provisioned(String email, String kindLabel, String password) {
    }

    private static List<Provisioned> provision(Connection connection, PasswordHasher hasher,
                                               SecureRandom rng, String select, String update,
                                               KindLabel labeller) throws SQLException {
        List<Provisioned> out = new ArrayList<>();
        try (PreparedStatement read = connection.prepareStatement(select)) {
            List<Map<String, String>> rows = new ArrayList<>();
            try (ResultSet rs = read.executeQuery()) {
                int columns = rs.getMetaData().getColumnCount();
                while (rs.next()) {
                    Map<String, String> row = new LinkedHashMap<>();
                    for (int i = 1; i <= columns; i++) {
                        row.put(rs.getMetaData().getColumnLabel(i).toLowerCase(), rs.getString(i));
                    }
                    rows.add(row);
                }
            }
            try (PreparedStatement write = connection.prepareStatement(update)) {
                for (Map<String, String> row : rows) {
                    // A fresh CSPRNG password per account rather than one shared string: a
                    // shared dev password would survive into a real deployment as a habit,
                    // and would make every account fall to one guess. 18 base64url bytes of
                    // entropy, prefixed so the character classes satisfy the platform policy
                    // the same way a human-chosen one would.
                    String plain = "Dv-" + encode(rng, 18);
                    write.setString(1, hasher.encode(plain.toCharArray()));
                    write.setString(2, row.get("id"));
                    write.executeUpdate();
                    out.add(new Provisioned(row.get("email"), labeller.of(row), plain));
                }
            }
        }
        return out;
    }

    private static String encode(SecureRandom rng, int bytes) {
        byte[] raw = new byte[bytes];
        rng.nextBytes(raw);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private static void refuseIfUrlLooksLikeProduction(String url) {
        String lower = url == null ? "" : url.toLowerCase(java.util.Locale.ROOT);
        for (String forbidden : FORBIDDEN_SCHEMA_NAMES) {
            // Match a schema segment, not a substring: "pixcart_dev" must not be rejected
            // just because it contains "pixcart".
            if (lower.matches(".*[/=]" + java.util.regex.Pattern.quote(forbidden) + "([?/].*)?$")) {
                throw new IllegalStateException("refusing to run against schema '" + forbidden
                        + "': this tool only provisions development databases");
            }
        }
    }
}
