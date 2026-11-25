/* Admin → Go-live checklist: everything between staging and launch, ticked live from the server. Port of frontend/src/app/admin/go-live/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { CheckCircle2, CircleDashed, Rocket } from "lucide-angular";
import { api, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Pill } from "../../shared/ui/ui";

type Item = { key: string; label: string; done: boolean; detail: string; href: string; who: "admin" | "terraform" | "lawyer" | "ca"; required: boolean };
type D = { environment: string; done: number; total: number; ready: boolean; sections: { title: string; items: Item[] }[] };
const WHO: Record<Item["who"], string> = { admin: "You, in this panel", terraform: "Terraform / DevOps", lawyer: "Your lawyer", ca: "Your CA" };

@Component({
  selector: "pc-admin-go-live-page",
  imports: [PageHeader, Icon, PcLink, PageLoader, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Go-live checklist" sub="Everything between staging and launch, in order. Items marked Optional can wait. The full step-by-step guide is docs/GO_LIVE.md in the code." [withActions]="true">
          <pc-pill actions [tone]="d()!.ready ? 'green' : 'amber'">{{ d()!.ready ? "Ready to launch" : d()!.done + " of " + d()!.total + " required done" }}</pc-pill>
        </pc-page-header>
        <div class="rounded-xl bg-white p-4">
          <div class="flex items-center gap-3">
            <svg [pcIcon]="Rocket" class="h-5 w-5 text-peacock" />
            <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-mist" role="progressbar" [attr.aria-valuenow]="pct()" aria-valuemin="0" aria-valuemax="100" aria-label="Launch readiness">
              <div class="h-full rounded-full bg-peacock transition-all" [style.width.%]="pct()"></div>
            </div>
            <span class="w-12 text-right font-semibold tabular-nums">{{ pct() }}%</span>
          </div>
        </div>
        @for (s of d()!.sections; track s.title) {
          <section class="rounded-xl bg-white p-4">
            <h2 class="mb-2 font-semibold">{{ s.title }}</h2>
            <ul class="divide-y divide-line">
              @for (i of s.items; track i.key) {
                <li class="flex flex-wrap items-center gap-3 py-2.5">
                  @if (i.done) {<svg [pcIcon]="CheckCircle2" class="h-5 w-5 shrink-0 text-leaf" />} @else {<svg [pcIcon]="CircleDashed" class="h-5 w-5 shrink-0 text-ink-faint" />}
                  <div class="min-w-0 flex-1">
                    <p class="font-medium">{{ i.label }}@if (!i.required) {<span class="ml-2 text-xs font-normal text-ink-faint">Optional</span>}</p>
                    @if (i.detail) {<p class="break-words text-sm text-ink-soft">{{ i.detail }}</p>}
                  </div>
                  <span class="text-xs text-ink-faint">{{ who[i.who] }}</span>
                  @if (i.href) {<a [pcLink]="i.href" class="text-sm font-semibold text-peacock">{{ i.done ? "Review" : "Set up" }}</a>}
                </li>
              }
            </ul>
          </section>
        }
      </div>
    }
  `,
})
export class AdminGoLivePage {
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly CircleDashed = CircleDashed;
  protected readonly Rocket = Rocket;
  protected readonly who = WHO;
  protected readonly d = signal<D | null>(null);
  protected readonly pct = computed(() => {
    const d = this.d();
    return d ? Math.round((d.done / Math.max(1, d.total)) * 100) : 0;
  });

  constructor() {
    api<D>("/api/admin/go-live").then((x) => this.d.set(x)).catch(quietly);
  }
}
