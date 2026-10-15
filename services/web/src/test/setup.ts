import '@testing-library/jest-dom/vitest';

/**
 * jsdom does not implement `matchMedia`, but the design system's motion handling
 * reads it to honour `prefers-reduced-motion` (Vol. 8 §8.1). Without this stub every
 * component that touches the preference throws in tests.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

/** jsdom has no `scrollTo`; routing and focus management call it on navigation. */
Object.defineProperty(window, 'scrollTo', { writable: true, value: () => {} });

/**
 * `IntersectionObserver` is used by lazy-loaded rails. jsdom does not implement it,
 * and a missing global is a confusing failure that looks like a product bug.
 */
if (!('IntersectionObserver' in window)) {
  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    },
  });
}
