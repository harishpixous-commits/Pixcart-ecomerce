"use client";

import clsx from "clsx";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FullLoader } from "@/components/delivery/app";
import { Button } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type N = { id: string; title: string; body: string; link: string; read: boolean; at: string };

/** The partner's messages: new requests, approvals, payouts. Links to the shop are opened in the partner app where they exist. */
export default function PartnerNotifications() {
  const [items, setItems] = useState<N[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ items: N[] }>("/api/notifications").then((r) => { if (live) setItems(r.items); }).catch(quietly);
    return () => { live = false; };
  }, []);
  if (!items) return <FullLoader />;
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        {items.some((n) => !n.read) && (
          <Button variant="ghost" size="sm" onClick={() => api("/api/notifications/read-all", { method: "POST" }).then(() => setItems(items.map((n) => ({ ...n, read: true })))).catch(quietly)}>Mark all as read</Button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-3xl bg-white p-10 text-center shadow-sm">
          <Bell className="h-10 w-10 text-ink-faint" aria-hidden />
          <p className="font-semibold">Nothing yet</p>
          <p className="text-sm text-ink-soft">Delivery requests, approvals and payouts show up here.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5">
          {items.map((n) => {
            const body = (
              <div className={clsx("flex gap-3 px-4 py-3.5", !n.read && "bg-peacock-light/40")}>
                <span className={clsx("mt-2 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-vermilion")} aria-hidden />
                <div>
                  <p className="font-semibold">{n.title}</p>
                  <p className="text-ink-soft">{n.body}</p>
                  <p className="text-xs text-ink-faint">{dateTime(n.at)}</p>
                </div>
              </div>
            );
            return <li key={n.id}>{n.link?.startsWith("/delivery") ? <Link href={n.link} className="block hover:bg-mist">{body}</Link> : body}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
