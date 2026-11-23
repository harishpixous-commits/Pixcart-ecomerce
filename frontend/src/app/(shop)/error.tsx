"use client";

import { ErrorView } from "@/components/error-pages";

/** A shop page failed while loading: the theme's header and footer stay, with a retry and a reference. */
export default function ShopError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} area="shop" />;
}
