"use client";

import { History } from "lucide-react";

export default function PartnerHistory() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-3xl bg-white p-10 text-center shadow-sm ring-1 ring-black/5">
      <History className="h-10 w-10 text-peacock" aria-hidden />
      <h1 className="text-xl font-bold">Delivery history</h1>
      <p className="text-ink-soft">Completed deliveries show up here.</p>
    </div>
  );
}
