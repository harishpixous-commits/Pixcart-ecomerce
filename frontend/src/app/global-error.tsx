"use client";

import "./globals.css";

/**
 * The last safety net: the whole app (its root layout) failed. Nothing else can render, so this page stands alone with
 * fixed text and the default colours; every other error page is in the shop's theme or the portal's shell.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-IN">
      <body className="flex min-h-screen items-center justify-center bg-mist p-6 font-sans text-ink">
        <main className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-card" data-testid="global-error">
          <h1 className="font-display text-2xl font-bold">Something went wrong</h1>
          <p className="mt-3 text-ink-soft">We could not load this page. Please try again in a moment.</p>
          <div className="mt-6 flex justify-center gap-2">
            <button type="button" onClick={reset} className="rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white">Try again</button>
            {/* a full page load on purpose: the app itself failed, so client navigation cannot be trusted */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="rounded-lg border border-line px-4 py-2.5 font-semibold">Home page</a>
          </div>
          {error.digest && <p className="mt-5 text-xs text-ink-faint">Reference: <span className="font-mono">{error.digest}</span></p>}
        </main>
      </body>
    </html>
  );
}
