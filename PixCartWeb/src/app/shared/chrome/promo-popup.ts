/*
 * The one-time welcome popup. Shows only when Admin → Growth → Promo popup is on, once per browser until its words change.
 */

import { ChangeDetectionStrategy, Component, OnDestroy, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { api, quietly } from "../../core/api";

type Popup = { enabled: boolean; title?: string; body?: string; button_label?: string; link?: string; delay_seconds?: number };

@Component({
  selector: "pc-promo-popup",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents", "(document:keydown.escape)": "close()" },
  template: `
    @if (open()) {
      @if (p(); as x) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="promo-popup" (click)="close()">
          <div role="dialog" aria-modal="true" aria-labelledby="promo-popup-h" class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" (click)="$event.stopPropagation()">
            <h2 id="promo-popup-h" class="text-xl font-semibold">{{ x.title }}</h2>
            @if (x.body) {<p class="mt-2 text-ink-soft">{{ x.body }}</p>}
            <div class="mt-4 flex gap-2">
              @if (x.link && x.button_label) {
                <a [routerLink]="x.link" (click)="close()" class="inline-flex min-h-11 items-center rounded-lg bg-peacock px-4 font-semibold text-white">{{ x.button_label }}</a>
              }
              <button type="button" class="min-h-11 rounded-lg px-4 text-ink-soft" (click)="close()">Close</button>
            </div>
          </div>
        </div>
      }
    }
  `,
})
export class PromoPopup implements OnDestroy {
  protected readonly p = signal<Popup | null>(null);
  protected readonly open = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    api<Popup>("/api/promo-popup").then((x) => {
      if (!x.enabled) return;
      try { if (localStorage.getItem(this.key(x))) return; } catch { /* storage blocked: show it each visit */ }
      this.p.set(x);
      this.timer = setTimeout(() => this.open.set(true), (x.delay_seconds ?? 5) * 1000);
    }).catch(quietly);
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    const x = this.p();
    try { if (x) localStorage.setItem(this.key(x), "1"); } catch { /* ignore */ }
  }

  private key(x: Popup): string { return "pc_popup_" + (x.title ?? "") + "|" + (x.body ?? ""); }

  ngOnDestroy(): void { clearTimeout(this.timer); }
}
