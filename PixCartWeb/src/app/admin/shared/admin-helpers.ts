/*
 * Small helpers for the admin pages ported from React hooks.
 *   debounced(source, ms, after?)   a signal that follows `source` (trimmed) once it has been still for `ms`, like the
 *                                   reference's setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300) effect.
 *   searchParam(name)               one query parameter of the current address as a signal (useSearchParams().get).
 */

import { DestroyRef, computed, effect, inject, signal, untracked, type Signal } from "@angular/core";
import { RouteState } from "../../core/route-state";

/** Call in an injection context. `after` runs right after the value is applied (e.g. back to page 1). */
export function debounced(source: Signal<string>, ms: number, after?: () => void): Signal<string> {
  const out = signal(untracked(source).trim());
  let t: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const v = source();
    clearTimeout(t);
    t = setTimeout(() => {
      out.set(v.trim());
      after?.();
    }, ms);
  });
  inject(DestroyRef).onDestroy(() => clearTimeout(t));
  return out.asReadonly();
}

/** useSearchParams().get(name) as a signal. Call in an injection context. */
export function searchParam(name: string): Signal<string | null> {
  const route = inject(RouteState);
  return computed(() => route.params().get(name));
}
