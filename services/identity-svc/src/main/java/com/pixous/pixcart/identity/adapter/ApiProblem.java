package com.pixous.pixcart.identity.adapter;

/**
 * RFC 7807 problem document, with the two platform extensions this contract names:
 * {@code code} (a stable machine-readable error code) and {@code traceId} (the correlation
 * id echoed from {@code x-trace-id}).
 *
 * <p>Component order is the documented wire order — {@code type,title,status,detail,code,
 * traceId} — and Jackson serialises a record in declaration order, so the shape is fixed by
 * the type rather than by configuration. The Node BFF and the mobile clients key off
 * {@code code}, so renaming a component is a breaking change.
 *
 * <p>{@code type} is a URN rather than an {@code https://} URL: no error-reference host is
 * published by this platform, and a {@code type} that looks resolvable but is not is worse
 * than one that obviously is not.
 */
public record ApiProblem(String type, String title, int status, String detail, String code, String traceId) {

    /** URN namespace for every problem this service emits. */
    public static final String TYPE_PREFIX = "urn:pixcart:error:";

    public static ApiProblem of(int status, String code, String title, String detail, String traceId) {
        if (code == null || code.isBlank()) throw new IllegalArgumentException("code");
        return new ApiProblem(TYPE_PREFIX + code, title, status, detail, code, traceId);
    }
}
