/*
 * The explainable risk brief of the admin panel (a rule-based score with every factor listed), on the order and
 * seller pages; AiBadge and AiDraftButton are in shared/portal/ai.ts:
 *   <pc-risk-brief [path]="'/api/admin/ai/briefs/order/' + id" title="Order risk" />
 *   <pc-risk-brief [path]="'/api/admin/ai/briefs/seller/' + id" title="Seller health (last 90 days)" />
 */

import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from "@angular/core";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import { Icon } from "../../shared/ui/icon";
import { Spinner } from "../../shared/ui/ui";

export type Brief = { score: number; level: "GREEN" | "AMBER" | "RED"; headline: string; factors: { weight: number; text: string }[]; notes: string[]; insufficient_history: boolean };

const LEVEL = {
  GREEN: { icon: CheckCircle2, cls: "border-leaf bg-leaf-light", text: "text-leaf" },
  AMBER: { icon: AlertTriangle, cls: "border-marigold bg-marigold-light", text: "text-[#8A5A00]" },
  RED: { icon: ShieldAlert, cls: "border-vermilion bg-vermilion/5", text: "text-vermilion" },
};

@Component({
  selector: "pc-risk-brief",
  imports: [Icon, Spinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!error()) {
      @if (!b()) {
        <section class="rounded-xl bg-white p-4"><svg pcSpinner /></section>
      } @else {
        @let x = b()!;
        <section [class]="'rounded-xl border p-4 ' + L().cls" [attr.aria-label]="title()">
          <div class="flex items-center gap-2">
            <svg [pcIcon]="L().icon" [class]="'h-5 w-5 ' + L().text" />
            <h2 class="font-semibold">{{ title() }}</h2>
            <span [class]="'ml-auto text-sm font-bold ' + L().text">{{ x.score }}/100</span>
          </div>
          <p [class]="'mt-1 font-semibold ' + L().text">{{ x.headline }}</p>
          @if (x.factors.length > 0) {
            <ul class="mt-2 flex flex-col gap-1 text-sm">@for (f of x.factors; track f.text) {<li class="flex justify-between gap-3"><span>{{ f.text }}</span><span class="text-ink-faint">+{{ f.weight }}</span></li>}</ul>
          } @else {
            <p class="mt-1 text-sm text-ink-soft">No risk signals found.</p>
          }
          @for (n of x.notes; track n) {<p class="mt-2 text-xs text-ink-soft">{{ n }}</p>}
          @if (x.insufficient_history) {<p class="mt-1 text-xs text-ink-faint">Little history yet, so treat the score as a rough guide.</p>}
        </section>
      }
    }
  `,
})
export class RiskBrief {
  readonly path = input.required<string>();
  readonly title = input.required<string>();
  protected readonly b = signal<Brief | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly L = computed(() => LEVEL[this.b()?.level ?? "GREEN"]);

  constructor() {
    effect(() => {
      const path = this.path();
      api<Brief>(path).then((b) => this.b.set(b)).catch((e) => this.error.set(e instanceof ApiError ? e.message : null));
    });
  }
}
