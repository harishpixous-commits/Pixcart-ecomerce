"use client";

import { CheckCircle2, CircleDashed, Rocket } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { PageLoader, Pill } from "@/components/ui";
import { api, quietly } from "@/lib/api";

type Item = { key: string; label: string; done: boolean; detail: string; href: string; who: "admin" | "terraform" | "lawyer" | "ca"; required: boolean };
type D = { environment: string; done: number; total: number; ready: boolean; sections: { title: string; items: Item[] }[] };
const WHO: Record<Item["who"], string> = { admin: "You, in this panel", terraform: "Terraform / DevOps", lawyer: "Your lawyer", ca: "Your CA" };

export default function GoLive() {
  const [d, setD] = useState<D | null>(null);
  useEffect(() => { api<D>("/api/admin/go-live").then(setD).catch(quietly); }, []);
  if (!d) return <PageLoader />;
  const pct = Math.round((d.done / Math.max(1, d.total)) * 100);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Go-live checklist" sub="Everything between staging and launch, in order. Items marked Optional can wait. The full step-by-step guide is docs/GO_LIVE.md in the code."
        actions={<Pill tone={d.ready ? "green" : "amber"}>{d.ready ? "Ready to launch" : `${d.done} of ${d.total} required done`}</Pill>} />
      <div className="rounded-xl bg-white p-4">
        <div className="flex items-center gap-3">
          <Rocket className="h-5 w-5 text-peacock" />
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-mist" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Launch readiness">
            <div className="h-full rounded-full bg-peacock transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-12 text-right font-semibold tabular-nums">{pct}%</span>
        </div>
      </div>
      {d.sections.map((s) => (
        <section key={s.title} className="rounded-xl bg-white p-4">
          <h2 className="mb-2 font-semibold">{s.title}</h2>
          <ul className="divide-y divide-line">
            {s.items.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-3 py-2.5">
                {i.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-leaf" /> : <CircleDashed className="h-5 w-5 shrink-0 text-ink-faint" />}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.label}{!i.required && <span className="ml-2 text-xs font-normal text-ink-faint">Optional</span>}</p>
                  {i.detail && <p className="break-words text-sm text-ink-soft">{i.detail}</p>}
                </div>
                <span className="text-xs text-ink-faint">{WHO[i.who]}</span>
                {i.href && <Link href={i.href} className="text-sm font-semibold text-peacock">{i.done ? "Review" : "Set up"}</Link>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
