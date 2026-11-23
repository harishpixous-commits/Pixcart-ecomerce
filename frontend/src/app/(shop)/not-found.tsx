import type { Metadata } from "next";
import { NotFoundView } from "@/components/error-pages";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

/** In the shop's theme: its header, footer and colours, with the owner's text, a search box and suggestions. */
export default function ShopNotFound() {
  return <NotFoundView area="shop" />;
}
