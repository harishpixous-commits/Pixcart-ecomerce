"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ButtonLink, EmptyState, PageLoader, StatusPill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type T = { id: string; number: string; subject: string; category_label: string; status: string; updated_at: string; is_grievance: boolean };
const STATUS: Record<string, string> = { open: "Waiting for us", awaiting_customer: "Waiting for you", resolved: "Resolved", closed: "Closed" };

export default function SupportPage() {
  const { user, ready } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/support");
    if (user) api<{ items: T[] }>("/api/support/tickets").then((r) => setItems(r.items)).catch(quietly);
  }, [ready, user, router]);
  if (!items) return <PageLoader />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h1 className="text-2xl font-semibold">Help and support</h1>
        <ButtonLink href="/support/new">Contact support</ButtonLink>
      </div>
      <p className="px-1 text-ink-soft">We reply to every request within 48 hours. For a problem with an order, the fastest way is the Need help link on the order page.</p>
      {items.length === 0 ? (
        <EmptyState title="No requests yet" body="If something is wrong, tell us and we will sort it out." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl bg-white">
          {items.map((t) => (
            <li key={t.id}>
              <Link href={`/support/${t.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-mist">
                <div>
                  <p className="font-semibold">{t.subject}</p>
                  <p className="text-sm text-ink-faint">{t.number}, {t.category_label}{t.is_grievance ? ", grievance" : ""}, updated {dateTime(t.updated_at)}</p>
                </div>
                <StatusPill status={t.status === "awaiting_customer" ? "pending" : t.status === "open" ? "placed" : "approved"} label={STATUS[t.status]} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
