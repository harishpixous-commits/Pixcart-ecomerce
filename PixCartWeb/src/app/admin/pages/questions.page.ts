/* Admin → Questions and answers: posts waiting for a check, published and hidden posts. Port of frontend/src/app/admin/questions/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Search } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, latestOnly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Pagination, Pill, Toast } from "../../shared/ui/ui";
import { debounced } from "../shared/admin-helpers";

type Post = {
  kind: "question" | "answer"; id: string; text: string; product: string; slug: string; author: string; role: string; report_count: number;
  created_at: string; question: string;
};
type Data = { items: Post[]; total: number; page: number; page_size: number; counts: Record<string, number> };

const ROLE: Record<string, string> = { seller: "Seller", buyer: "Verified buyer", customer: "Customer", staff: "Store team" };

@Component({
  selector: "pc-admin-questions-page",
  imports: [PageHeader, Tabs, Icon, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Pagination, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Questions and answers" sub="Posts waiting for a check (contact details, reports or the check-every-post switch), and every published or hidden post." [withActions]="canSettings()">
        @if (canSettings()) {<a actions pcLink="/admin/product-page#qa" class="inline-flex h-10 items-center rounded-lg px-4 font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">Q&amp;A settings</a>}
      </pc-page-header>
      <pc-tabs [value]="tab()" (valueChange)="tab.set($event); page.set(1)" [items]="tabs()" />
      <div class="relative mb-3 max-w-md">
        <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search the text or product" aria-label="Search questions and answers" class="pl-9" />
      </div>
      <pc-error-note [message]="error()" />
      @if (!d()) {
        @if (!error()) {<pc-page-loader />}
      } @else if (d()!.items.length === 0) {
        <pc-empty-state [title]="tab() === 'pending' ? 'Nothing waiting' : 'Nothing here'" [body]="tab() === 'pending' ? 'Questions and answers that need a check show up here.' : undefined" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (p of d()!.items; track p.kind + p.id) {
            <section class="rounded-xl bg-white p-4" data-testid="qa-post">
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <pc-pill [tone]="p.kind === 'question' ? 'blue' : 'gray'">{{ p.kind === "question" ? "Question" : "Answer" }}</pc-pill>
                @if (p.report_count > 0) {<pc-pill tone="red">{{ p.report_count }} report{{ p.report_count === 1 ? "" : "s" }}</pc-pill>}
                <a [href]="'/p/' + p.slug + '#questions'" target="_blank" rel="noreferrer" class="font-semibold hover:text-peacock">{{ p.product }}</a>
                <span class="ml-auto text-xs text-ink-faint">{{ dateTime(p.created_at) }}</span>
              </div>
              @if (p.kind === "answer" && p.question) {<p class="mt-2 text-sm text-ink-soft">Q: {{ p.question }}</p>}
              <p class="mt-1.5 whitespace-pre-line">{{ p.text }}</p>
              <p class="mt-1 text-xs text-ink-faint">{{ p.author }} · {{ role[p.role] ?? p.role }}</p>
              <div class="mt-3 flex flex-wrap gap-2">
                @if (tab() !== "published") {<button pcButton size="sm" [loading]="busy() === p.id + 'publish'" (click)="act(p, 'publish')">Publish</button>}
                @if (tab() !== "hidden") {<button pcButton size="sm" variant="danger" [loading]="busy() === p.id + 'hide'" (click)="act(p, 'hide')">Hide</button>}
              </div>
            </section>
          }
        </div>
      }
      @if (d()) {<pc-pagination [page]="page()" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />}
    </div>
  `,
})
export class AdminQuestionsPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly Search = Search;
  protected readonly dateTime = dateTime;
  protected readonly role = ROLE;
  protected readonly canSettings = computed(() => this.admin.can("settings"));
  protected readonly tab = signal<string>("pending");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  private readonly track = latestOnly();
  private readonly query = debounced(this.q, 300, () => this.page.set(1));
  protected readonly tabs = computed(() => {
    const c = this.d()?.counts ?? {};
    return [
      { value: "pending", label: "Waiting for a check", count: c["pending"] ?? 0 }, { value: "published", label: "Published", count: c["published"] ?? 0 },
      { value: "hidden", label: "Hidden", count: c["hidden"] ?? 0 },
    ];
  });

  constructor() {
    effect(() => this.load());
  }

  private load(): void {
    const tab = this.tab(), query = this.query(), page = this.page();
    this.track(api<Data>("/api/admin/questions", { query: { status: tab, q: query || undefined, page } }), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load questions"));
  }

  protected async act(p: Post, action: "publish" | "hide"): Promise<void> {
    this.busy.set(p.id + action);
    try {
      await api(`/api/admin/questions/${p.kind}/${p.id}/${action}`, { method: "POST" });
      const what = p.kind === "question" ? "Question" : "Answer";
      this.toast.show(action === "publish" ? `${what} published` : `${what} hidden`);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update", "error");
    } finally {
      this.busy.set(null);
    }
  }
}
