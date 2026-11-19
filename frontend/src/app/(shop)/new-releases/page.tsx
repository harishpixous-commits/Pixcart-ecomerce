import type { Metadata } from "next";
import { Suspense } from "react";
import { TopList } from "@/components/top-list";

export const metadata: Metadata = { title: "Hot new releases", description: "New products that are selling fast." };

export default function NewReleasesPage() {
  return (
    <Suspense>
      <TopList list="new" />
    </Suspense>
  );
}
