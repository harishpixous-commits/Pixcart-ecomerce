/* Help and support: the shopper's requests with their status, and "Contact support". Port of frontend/src/app/(shop)/support/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { SessionService } from "../../core/session";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink, EmptyState, StatusPill } from "../../shared/ui/ui";

type T = { id: string; number: string; subject: string; category_label: string; status: string; updated_at: string; is_grievance: boolean };
const STATUS: Record<string, string> = { open: "Waiting for us", awaiting_customer: "Waiting for you", resolved: "Resolved", closed: "Closed" };

@Component({
  selector: "pc-shop-support-page",
  imports: [PcLink, PageLoader, ButtonLink, EmptyState, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!items()) {
      <pc-page-loader />
    } @else {
      <div class="mx-auto flex max-w-3xl flex-col gap-3">
        <div class="flex items-center justify-between px-1">
          <h1 class="text-2xl font-semibold">Help and support</h1>
          <a pcButtonLink href="/support/new">Contact support</a>
        </div>
        <p class="px-1 text-ink-soft">We reply to every request within 48 hours. For a problem with an order, the fastest way is the Need help link on the order page.</p>
        @if (items()!.length === 0) {
          <pc-empty-state title="No requests yet" body="If something is wrong, tell us and we will sort it out." [hasAction]="false" />
        } @else {
          <ul class="divide-y divide-line overflow-hidden rounded-xl bg-white">
            @for (t of items(); track t.id) {
              <li>
                <a [pcLink]="'/support/' + t.id" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-mist">
                  <div>
                    <p class="font-semibold">{{ t.subject }}</p>
                    <p class="text-sm text-ink-faint">{{ t.number }}, {{ t.category_label }}{{ t.is_grievance ? ", grievance" : "" }}, updated {{ dateTime(t.updated_at) }}</p>
                  </div>
                  <pc-status-pill [status]="t.status === 'awaiting_customer' ? 'pending' : t.status === 'open' ? 'placed' : 'approved'" [label]="STATUS[t.status]" />
                </a>
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class ShopSupportPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly items = signal<T[] | null>(null);
  protected readonly dateTime = dateTime;
  protected readonly STATUS = STATUS;

  constructor() {
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && !user) void this.router.navigateByUrl("/login?next=/support", { replaceUrl: true });
      if (user) untracked(() => api<{ items: T[] }>("/api/support/tickets").then((r) => this.items.set(r.items)).catch(quietly));
    });
  }
}
