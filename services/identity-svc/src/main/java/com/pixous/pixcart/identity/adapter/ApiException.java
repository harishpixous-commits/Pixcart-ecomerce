package com.pixous.pixcart.identity.adapter;

/**
 * A refusal with an HTTP status and a stable {@code code}.
 *
 * <p>Every message is written to <em>name what was refused</em> — a detail that says only
 * "bad request" is indistinguishable from a bug. The codes below are either the ones the
 * documentation already fixes (E-AUTH-002/003/004/011) or self-describing names for
 * refusals the documentation does not number; inventing an {@code E-XXX-nnn} would imply a
 * catalogue entry that does not exist.
 */
public class ApiException extends RuntimeException {

    public static final String MALFORMED_REQUEST = "MALFORMED_REQUEST";
    public static final String PASSWORD_POLICY_REJECTED = "PASSWORD_POLICY_REJECTED";
    public static final String EMAIL_ALREADY_REGISTERED = "EMAIL_ALREADY_REGISTERED";
    public static final String THROTTLED = "THROTTLED";
    public static final String AUTH_REQUIRED = "AUTH_REQUIRED";
    public static final String TOKEN_MALFORMED = "TOKEN_MALFORMED";
    public static final String TOKEN_INVALID = "TOKEN_INVALID";
    public static final String SESSION_INACTIVE = "SESSION_INACTIVE";
    public static final String PRINCIPAL_NOT_FOUND = "PRINCIPAL_NOT_FOUND";
    public static final String REFRESH_TOKEN_INVALID = "REFRESH_TOKEN_INVALID";
    public static final String REFRESH_TOKEN_EXPIRED = "REFRESH_TOKEN_EXPIRED";
    public static final String REFRESH_TOKEN_REUSE_DETECTED = "REFRESH_TOKEN_REUSE_DETECTED";
    public static final String ROLE_UNKNOWN = "ROLE_UNKNOWN";
    public static final String CAPABILITY_UNKNOWN = "CAPABILITY_UNKNOWN";
    public static final String STEP_UP_ACTION_UNKNOWN = "STEP_UP_ACTION_UNKNOWN";
    public static final String STEP_UP_PROOF_REQUIRED = "STEP_UP_PROOF_REQUIRED";
    public static final String DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE";
    public static final String INTERNAL_ERROR = "INTERNAL_ERROR";
    public static final String NOT_FOUND = "NOT_FOUND";

    private final int status;
    private final String code;
    private final String title;

    public ApiException(int status, String code, String title, String detail) {
        super(detail);
        this.status = status;
        this.code = code;
        this.title = title;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public String title() {
        return title;
    }

    public static ApiException badRequest(String code, String detail) {
        return new ApiException(400, code, "Bad request", detail);
    }

    public static ApiException unauthorised(String code, String detail) {
        return new ApiException(401, code, "Unauthenticated", detail);
    }

    public static ApiException forbidden(String code, String detail) {
        return new ApiException(403, code, "Forbidden", detail);
    }

    public static ApiException conflict(String code, String detail) {
        return new ApiException(409, code, "Conflict", detail);
    }

    public static ApiException tooManyRequests(String code, String detail) {
        return new ApiException(429, code, "Too many requests", detail);
    }
}
