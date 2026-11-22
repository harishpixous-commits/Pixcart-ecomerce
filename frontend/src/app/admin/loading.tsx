"use client";

import { AdminPageSkeleton } from "@/components/skeletons";

/** While an admin page loads (inside the admin layout): a page title, cards and a table. */
export default function Loading() {
  return <AdminPageSkeleton />;
}
