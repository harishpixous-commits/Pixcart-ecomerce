"use client";

/* The card and heading every checkout section is built from, so the page reads as one surface. */

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

export const CARD = "rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5";

export function Card({ id, labelledBy, testId, className, children }: {
  id?: string; labelledBy?: string; testId?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} data-testid={testId} className={clsx(CARD, className)}>
      {children}
    </section>
  );
}

export function IconBadge({ icon: Icon, tone = "peacock" }: { icon: LucideIcon; tone?: "peacock" | "leaf" | "marigold" }) {
  return (
    <span
      className={clsx(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
        tone === "peacock" && "bg-peacock-light text-peacock",
        tone === "leaf" && "bg-leaf-light text-leaf",
        tone === "marigold" && "bg-marigold-light text-marigold-dark",
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </span>
  );
}

export function CardHeading({ id, icon, tone, title, sub, action }: {
  id: string; icon: LucideIcon; tone?: "peacock" | "leaf" | "marigold"; title: string; sub?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <IconBadge icon={icon} tone={tone} />
      <div className="min-w-0 flex-1 self-center">
        <h2 id={id} className="font-display text-lg font-semibold leading-tight text-ink">{title}</h2>
        {sub ? <p className="mt-0.5 text-sm leading-snug text-ink-soft">{sub}</p> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

/** A grey placeholder bar in the shape of the text that is loading. */
export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={clsx("skeleton block rounded-md", className)} />;
}
