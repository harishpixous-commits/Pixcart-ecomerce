/* Followed searches. SaveSearchButton sits on the search results page, SavedSearchesSection on the alerts page; both stay hidden while
   staff have saved searches switched off. Port of frontend/src/components/save-search.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from "@angular/core";
import { BellOff, BellPlus } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";
import { Toast } from "../ui/ui";

type Saved = { id: string; query: string; max_price_paise: number | null; last_notified_at: string | null };
type SavedList = { enabled: boolean; max_per_user: number; items: Saved[] };

abstract class SavedBase {
  protected readonly session = inject(SessionService);
  protected readonly toast = inject(Toast);
  protected readonly data = signal<SavedList | null>(null);

  constructor() {
    effect(() => {
      if (this.session.ready() && this.session.user()) untracked(() => this.load());
    });
  }

  protected load(): void {
    api<SavedList>("/api/saved-searches").then((r) => this.data.set(r)).catch(() => this.data.set(null));
  }
}

@Component({
  selector: "pc-save-search-button",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.user() && data()?.enabled && query().trim()) {
      <button type="button" (click)="follow()" [disabled]="has()" data-testid="save-search"
        class="mt-1 inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm font-semibold text-peacock disabled:text-ink-faint">
        <svg [pcIcon]="BellPlus" class="h-4 w-4" /> {{ has() ? "Following this search" : "Tell me about new matches" }}
      </button>
    }
  `,
})
export class SaveSearchButton extends SavedBase {
  readonly query = input.required<string>();
  readonly maxPaise = input<number | null>(null);
  protected readonly BellPlus = BellPlus;

  protected has(): boolean {
    const q = this.query().trim().toLowerCase().replace(/\s+/g, " ");
    return (this.data()?.items ?? []).some((s) => s.query.toLowerCase() === q && s.max_price_paise === this.maxPaise());
  }

  protected async follow(): Promise<void> {
    try {
      await api("/api/saved-searches", { method: "POST", body: { query: this.query(), max_price_paise: this.maxPaise() } });
      this.toast.show("We will tell you when new matches arrive");
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not save this search", "error");
    }
  }
}

@Component({
  selector: "pc-saved-searches-section",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data()?.enabled) {
      <section class="rounded-xl bg-white" aria-labelledby="saved-h">
        <h2 id="saved-h" class="border-b border-line px-4 py-3 text-lg font-semibold">Followed searches</h2>
        @if (data()!.items.length === 0) {
          <p class="px-4 py-6 text-ink-soft">None yet. On a search page, choose <span class="font-semibold">Tell me about new matches</span>.</p>
        } @else {
          <ul class="divide-y divide-line" data-testid="saved-searches">
            @for (s of data()!.items; track s.id) {
              <li class="flex items-center gap-3 px-4 py-3">
                <div class="min-w-0 flex-1">
                  <a [pcLink]="link(s)" class="font-medium hover:text-peacock">{{ s.query }}</a>
                  @if (s.max_price_paise !== null) {<p class="text-sm text-ink-faint">Up to {{ rupees(s.max_price_paise) }}</p>}
                </div>
                <button type="button" (click)="remove(s.id)" class="flex items-center gap-1 text-sm text-ink-soft hover:text-vermilion"><svg [pcIcon]="BellOff" class="h-4 w-4" /> Remove</button>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class SavedSearchesSection extends SavedBase {
  protected readonly BellOff = BellOff;
  protected readonly rupees = rupees;

  protected link(s: Saved): string {
    return `/search?q=${encodeURIComponent(s.query)}${s.max_price_paise ? `&max_price=${s.max_price_paise}` : ""}`;
  }

  protected async remove(id: string): Promise<void> {
    try {
      await api(`/api/saved-searches/${id}`, { method: "DELETE" });
      this.load();
      this.toast.show("Search removed");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not remove", "error");
    }
  }
}
