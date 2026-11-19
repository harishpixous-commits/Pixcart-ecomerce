import type { Metadata } from "next";
import { Suspense } from "react";
import { TopList } from "@/components/top-list";

export const metadata: Metadata = { title: "Bestsellers", description: "The most popular products, by units sold in the last 30 days." };

export default function BestsellersPage() {
  return (
    <Suspense>
      <TopList list="bestsellers" />
    </Suspense>
  );
}
