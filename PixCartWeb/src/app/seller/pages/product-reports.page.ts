/* Problems shoppers reported on the seller's listings, and the seller's answer to the team. Port of frontend/src/app/seller/product-reports/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { ApiError, api, latestOnly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, Pagination, Textarea, Toast } from "../../shared/ui/ui";

type Rep = {
  id: string; product_id: string; product: string; slug: string; reason: string; reason_label: string; note: string; url: string; status: string;
  admin_note: string; seller_note: string; at: string;
};
type D = { items: Rep[]; total: number; open: number };

@Component({
  selector: "pc-seller-product-reports-page",
  imports: [PageHeader, Tabs, PcLink, PageLoader, Button, EmptyState, Pagination, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Customer reports" sub="Shoppers can report a problem with a listing from the product page. You see what was reported (not who). Fix the listing and tell the team what you changed." />
      <pc-tabs [value]="status()" (valueChange)="setTab($event)" [items]="[
        { value: 'open', label: 'Open', count: d()?.open }, { value: 'resolved', label: 'Resolved' }, { value: 'dismissed', label: 'Dismissed' }, { value: '', label: 'All' }
      ]" />
      @if (!d()) {
        <pc-page-loader />
      } @else if (d()!.items.length === 0) {
        <pc-empty-state title="No reports" body="Good news: no customer has reported a problem here." [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (r of d()!.items; track r.id) {
            <section class="rounded-xl bg-white p-4">
              <div class="flex flex-wrap items-center gap-2">
                <span [class]="'rounded-full px-2 py-0.5 text-xs font-semibold ' + (serious.includes(r.reason) ? 'bg-vermilion-light text-vermilion' : 'bg-marigold-light text-ink')">{{ r.reason_label }}</span>
                <a [pcLink]="'/seller/products/' + r.product_id" class="font-semibold hover:text-peacock">{{ r.product }}</a>
                <span class="ml-auto text-xs text-ink-faint">{{ dateTime(r.at) }} · {{ r.status }}</span>
              </div>
              @if (r.note) {<p class="mt-2 whitespace-pre-line">{{ r.note }}</p>}
              @if (r.url) {<p class="mt-1 text-sm">Seen at: <span class="break-all">{{ r.url }}</span></p>}
              @if (r.admin_note) {<p class="mt-2 rounded-lg bg-peacock-light p-2 text-sm"><span class="font-semibold">Marketplace team:</span> {{ r.admin_note }}</p>}
              @if (r.seller_note) {<p class="mt-2 rounded-lg bg-mist p-2 text-sm"><span class="font-semibold">Your answer:</span> {{ r.seller_note }}</p>}
              @if (r.status === "open") {
                <div class="mt-3 flex flex-col gap-2">
                  <textarea pcTextarea rows="2" maxlength="2000" placeholder="What did you check or change? e.g. Corrected the net quantity on the listing" aria-label="Your answer"
                    [value]="answer()[r.id] ?? ''" (input)="setAnswer(r.id, $any($event.target).value)"></textarea>
                  <div class="flex gap-2">
                    <button pcButton size="sm" (click)="respond(r)" [disabled]="(answer()[r.id] ?? '').trim().length < 2">{{ r.seller_note ? "Update answer" : "Send answer" }}</button>
                    <a [pcLink]="'/seller/products/' + r.product_id" class="inline-flex h-8 items-center rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light">Edit the listing</a>
                  </div>
                </div>
              }
            </section>
          }
        </div>
      }
      @if (d()) {<pc-pagination [page]="page()" [pageSize]="20" [total]="d()!.total" (pageChange)="page.set($event)" />}
    </div>
  `,
})
export class SellerProductReportsPage {
  private readonly toast = inject(Toast);
  protected readonly dateTime = dateTime;
  protected readonly serious = ["counterfeit", "unsafe", "prohibited"];
  protected readonly status = signal("open");
  protected readonly page = signal(1);
  protected readonly d = signal<D | null>(null);
  protected readonly answer = signal<Record<string, string>>({});
  private readonly track = latestOnly();

  constructor() {
    effect(() => {
      const status = this.status();
      const page = this.page();
      untracked(() => this.load(status, page));
    });
  }

  private load(status = this.status(), page = this.page()): void {
    void this.track(api<D>("/api/seller/product-reports", { query: { status: status || undefined, page } }), (d) => this.d.set(d));
  }

  protected setTab(v: string): void {
    this.status.set(v);
    this.page.set(1);
  }

  protected setAnswer(id: string, v: string): void {
    this.answer.update((a) => ({ ...a, [id]: v }));
  }

  protected async respond(r: Rep): Promise<void> {
    try {
      await api(`/api/seller/product-reports/${r.id}/respond`, { method: "POST", body: { note: this.answer()[r.id] ?? "" } });
      this.toast.show("Your answer was sent to the marketplace team");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not send", "error");
    }
  }
}
