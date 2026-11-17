"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, EmptyState, PageLoader } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

type N = { id: string; title: string; body: string; link: string; read: boolean; at: string };

export default function NotificationsPage() {
  const { user, ready } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<N[] | null>(null);
  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/notifications");
    if (user) api<{ items: N[] }>("/api/notifications").then((r) => setItems(r.items));
  }, [ready, user, router]);
  if (!items) return <PageLoader />;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        {items.some((n) => !n.read) && (
          <Button variant="ghost" size="sm" onClick={() => api("/api/notifications/read-all", { method: "POST" }).then(() => setItems(items.map((n) => ({ ...n, read: true }))))}>Mark all as read</Button>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState title="No notifications" body="Order updates and replies from support will appear here." />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl bg-white">
          {items.map((n) => {
            const body = (
              <div className={clsx("flex gap-3 px-4 py-3", !n.read && "bg-peacock-light/40")}>
                <span className={clsx("mt-2 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-vermilion")} aria-hidden />
                <div>
                  <p className="font-semibold">{n.title}</p>
                  <p className="text-ink-soft">{n.body}</p>
                  <p className="text-xs text-ink-faint">{dateTime(n.at)}</p>
                </div>
              </div>
            );
            return <li key={n.id}>{n.link ? <Link href={n.link} className="block hover:bg-mist">{body}</Link> : body}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
