package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.domain.Ulid;

/**
 * Correlation id.
 *
 * <p>An inbound {@code x-trace-id} is honoured so a gateway can stitch its own trace to this
 * one; when it is absent a ULID is minted with the platform's own generator, so the id is
 * the same 26-character Crockford base32 shape used for every other key.
 */
public final class TraceId {

    public static final String HEADER = "x-trace-id";
    public static final String REQUEST_ATTRIBUTE = "com.pixous.pixcart.identity.traceId";

    private TraceId() {
    }

    public static String resolve(String inboundHeader) {
        if (inboundHeader != null && !inboundHeader.isBlank()) return inboundHeader.trim();
        return Ulid.next();
    }
}
