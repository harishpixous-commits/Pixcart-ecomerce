"use client";

import { Wallet } from "lucide-react";

export default function PartnerEarnings() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-3xl bg-white p-10 text-center shadow-sm ring-1 ring-black/5">
      <Wallet className="h-10 w-10 text-peacock" aria-hidden />
      <h1 className="text-xl font-bold">Earnings</h1>
      <p className="text-ink-soft">Your earnings show up here after your first delivery.</p>
    </div>
  );
}
