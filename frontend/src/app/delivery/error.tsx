"use client";

import { ErrorView } from "@/components/error-pages";

/** A page here failed while loading: the menu and header stay, with a retry and a reference. */
export default function DeliveryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} area="delivery" />;
}
