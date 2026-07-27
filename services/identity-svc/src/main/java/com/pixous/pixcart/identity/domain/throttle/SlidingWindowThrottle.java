package com.pixous.pixcart.identity.domain.throttle;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;

/**
 * Sliding-window event throttle.
 *
 * Instantiations mandated by the documentation:
 *   FR-CUS-001 errors:  OTP sends "max 5/hour/number"      → new SlidingWindowThrottle(5, 1 h)
 *   Vol. 7 §7.2:        "auth endpoints 20/min/IP"          → new SlidingWindowThrottle(20, 1 min)
 *
 * One instance guards one key (a number, an IP). Distribution across nodes is the
 * adapter's job (Redis, FR-MKT-001 pattern); the domain defines the exact semantics
 * the adapter must reproduce: an event remains countable until strictly more than
 * `window` has elapsed, so the 6th send is refused at exactly +1 h and admitted 1 ms later.
 */
public final class SlidingWindowThrottle {

    private final int limit;
    private final Duration window;
    private final ArrayDeque<Instant> events = new ArrayDeque<>();

    public SlidingWindowThrottle(int limit, Duration window) {
        if (limit < 1) throw new IllegalArgumentException("limit");
        if (window.isNegative() || window.isZero()) throw new IllegalArgumentException("window");
        this.limit = limit;
        this.window = window;
    }

    /** Record an event if the budget allows; returns whether it was admitted. */
    public boolean tryAcquire(Instant now) {
        evict(now);
        if (events.size() >= limit) return false;
        events.addLast(now);
        return true;
    }

    public int available(Instant now) {
        evict(now);
        return limit - events.size();
    }

    private void evict(Instant now) {
        Instant cutoff = now.minus(window);
        while (!events.isEmpty() && events.peekFirst().isBefore(cutoff)) {
            events.pollFirst();
        }
    }
}
