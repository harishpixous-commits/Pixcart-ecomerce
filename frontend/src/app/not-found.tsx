import type { Metadata } from "next";
import { NotFoundView } from "@/components/error-pages";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return <main className="mx-auto w-full max-w-shop px-3 sm:px-4"><NotFoundView area="shop" /></main>;
}
