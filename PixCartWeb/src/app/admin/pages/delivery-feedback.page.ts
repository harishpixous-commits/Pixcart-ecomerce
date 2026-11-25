/*
 * Admin → Delivery → Ratings and complaints: what customers said about their delivery partners. Resolve a complaint
 * with a note for the record. Port of frontend/src/app/admin/delivery/feedback/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { Router } from "@angular/router";
import { CheckCircle2, MessageSquareWarning, Star } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, Pagination, Pill, Textarea, Toast } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";

type Complaint = { id: string; assignment_id: string; partner: string; order_number: string; category: string; category_label: string; text: string;
  status: "open" | "resolved"; admin_note: string; at: string };
type Rating = { assignment_id: string; partner: string; order_number: string; rating: number; comment: string; at: string | null };
type Page<T> = { items: T[]; total: number; page: number; page_size: number; open?: number };

@Component({
  selector: "pc-resolve-complaint",
  imports: [Modal, ErrorNote, Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!complaint()" (close)="close.emit()" title="Resolve complaint">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        @if (complaint(); as c) {<p class="text-sm text-ink-soft">{{ c.category_label }} about {{ c.partner }}, order {{ c.order_number }}.</p>}
        <pc-error-note [message]="error()" />
        <textarea pcTextarea [value]="note()" (input)="note.set($any($event.target).value)" rows="3" required minlength="3" maxlength="500" placeholder="What was done (e.g. spoke to the partner, refunded the customer)" aria-label="Resolution note"></textarea>
        <button pcButton type="submit" [loading]="busy()" [disabled]="note().trim().length < 3" class="self-start">Mark resolved</button>
      </form>
    </pc-modal>
  `,
})
export class ResolveComplaint {
  readonly complaint = input<Complaint | null>(null);
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const c = this.complaint();
    if (!c) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/delivery/complaints/${c.id}/resolve`, { method: "POST", body: { note: this.note().trim() } });
      this.toast.show("Complaint resolved");
      this.note.set("");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not resolve");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-feedback-page",
  imports: [PageHeader, Tabs, Icon, PcLink, PageLoader, Button, EmptyState, ErrorNote, Pagination, Pill, ResolveComplaint],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Ratings and complaints" sub="What customers said about their delivery. Complaints need a decision; ratings feed each partner's score." />
    <pc-tabs [value]="tab()" (valueChange)="pick($event)" [items]="tabs()" />
    <pc-error-note [message]="error()" />
    @if (!shown()) {
      @if (!error()) {<pc-page-loader />}
    } @else if (tab() === "ratings") {
      @if (!shown()!.ratings?.items?.length) {
        <pc-empty-state title="No ratings yet" body="Customers rate the delivery on their order page after it arrives." [hasAction]="false" />
      } @else {
        <ul class="flex flex-col gap-2">
          @for (r of shown()!.ratings!.items; track r.assignment_id) {
            <li class="flex flex-col gap-1 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <p class="flex flex-wrap items-center gap-2">
                <span class="flex" [attr.aria-label]="r.rating + ' of 5'">@for (n of five; track n) {<svg [pcIcon]="Star" [class]="n <= r.rating ? 'h-4 w-4 fill-marigold text-marigold' : 'h-4 w-4 text-line'" />}</span>
                <span class="font-semibold">{{ r.partner }}</span>
                <a [pcLink]="'/admin/delivery/trips/' + r.assignment_id" class="text-sm font-semibold text-peacock">{{ r.order_number }}</a>
                <span class="text-xs text-ink-faint">{{ dateTime(r.at) }}</span>
              </p>
              @if (r.comment) {<p class="text-sm text-ink-soft">“{{ r.comment }}”</p>}
            </li>
          }
        </ul>
      }
    } @else if (!shown()!.complaints?.items?.length) {
      <pc-empty-state [title]="tab() === 'open' ? 'No open complaints' : 'No resolved complaints yet'" [body]="tab() === 'open' ? 'Customers can report a delivery problem from their order page.' : undefined" [hasAction]="false" />
    } @else {
      <ul class="flex flex-col gap-2" data-testid="complaints">
        @for (c of shown()!.complaints!.items; track c.id) {
          <li class="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:flex-row sm:items-start">
            <span [class]="c.status === 'open' ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-vermilion-light text-vermilion' : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-light text-leaf'">
              <svg [pcIcon]="c.status === 'open' ? MessageSquareWarning : CheckCircle2" class="h-5 w-5" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2">
                <span class="font-semibold">{{ c.category_label }}</span>
                <pc-pill [tone]="c.status === 'open' ? 'red' : 'green'">{{ c.status === "open" ? "Open" : "Resolved" }}</pc-pill>
              </p>
              <p class="text-sm text-ink-soft">Partner <b>{{ c.partner }}</b> · <a [pcLink]="'/admin/delivery/trips/' + c.assignment_id" class="font-semibold text-peacock">{{ c.order_number }}</a> · {{ dateTime(c.at) }}</p>
              @if (c.text) {<p class="mt-1 text-sm">“{{ c.text }}”</p>}
              @if (c.admin_note) {<p class="mt-1 rounded-lg bg-mist px-2 py-1 text-sm"><b>Resolution:</b> {{ c.admin_note }}</p>}
            </div>
            @if (c.status === "open") {<button pcButton size="sm" (click)="resolving.set(c)">Resolve</button>}
          </li>
        }
      </ul>
    }
    @if (pager(); as p) {<pc-pagination [page]="page()" [pageSize]="p.page_size" [total]="p.total" (pageChange)="page.set($event)" />}
    <pc-resolve-complaint [complaint]="resolving()" (close)="resolving.set(null)" (done)="resolving.set(null); load()" />
  `,
})
export class AdminDeliveryFeedbackPage {
  private readonly router = inject(Router);
  private readonly tabParam = searchParam("tab");
  protected readonly Star = Star;
  protected readonly MessageSquareWarning = MessageSquareWarning;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly dateTime = dateTime;
  protected readonly five = [1, 2, 3, 4, 5];
  protected readonly tab = computed(() => { const t = this.tabParam() ?? ""; return (["open", "resolved", "ratings"].includes(t) ? t : "open") as "open" | "resolved" | "ratings"; });
  protected readonly page = signal(1);
  private readonly data = signal<{ key: string; complaints?: Page<Complaint>; ratings?: Page<Rating> } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly resolving = signal<Complaint | null>(null);
  protected readonly shown = computed(() => { const d = this.data(); return d?.key === `${this.tab()}:${this.page()}` ? d : null; });
  protected readonly pager = computed(() => { const s = this.shown(); return s ? (s.complaints ?? s.ratings ?? null) : null; });
  protected readonly tabs = computed(() => [
    { value: "open", label: "Open complaints", count: this.tab() === "open" ? this.shown()?.complaints?.total : undefined },
    { value: "resolved", label: "Resolved" },
    { value: "ratings", label: "Ratings" },
  ]);

  constructor() {
    effect(() => this.load());
  }

  protected pick(v: string): void {
    this.page.set(1);
    void this.router.navigateByUrl(`/admin/delivery/feedback?tab=${v}`, { replaceUrl: true });
  }

  protected load(): void {
    const tab = this.tab();
    const page = this.page();
    const k = `${tab}:${page}`;
    const req = tab === "ratings"
      ? api<Page<Rating>>("/api/admin/delivery/feedback", { query: { kind: "ratings", page } }).then((r) => this.data.set({ key: k, ratings: r }))
      : api<Page<Complaint>>("/api/admin/delivery/feedback", { query: { kind: "complaints", status: tab, page } }).then((r) => this.data.set({ key: k, complaints: r }));
    req.then(() => this.error.set(null)).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load feedback"));
  }
}
