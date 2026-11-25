/*
 * "Turn on notifications" for this device. Shows only when the admin has set up Firebase and this browser (or the
 * Android app) has not been asked yet; if permission was given before, it quietly refreshes the device instead.
 * "Not now" hides it for a week. Blocked notifications get a short how-to-fix note where it matters (delivery app).
 * Port of components/push-prompt.tsx:
 *   <pc-push-prompt app="delivery" [showBlocked]="true" title="..." text="..." extraClass="..." />
 */

import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, computed, inject, input, signal } from "@angular/core";
import { BellOff, BellRing, X } from "lucide-angular";
import { enablePush, pushConfig, pushPermission, type PushApp } from "../../core/push";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { Toast } from "../ui/ui";

const WEEK = 7 * 86_400_000;

function dismissedAt(app: PushApp): number {
  try {
    return Number(localStorage.getItem(`pc_push_later_${app}`) || 0);
  } catch {
    return 0;
  }
}

@Component({
  selector: "pc-push-prompt",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (state() !== "hidden") {
      <div role="region" aria-label="Notifications" data-testid="push-prompt" [class]="boxCls()">
        <span [class]="state() === 'blocked' ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-vermilion' : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock'">
          <svg [pcIcon]="state() === 'blocked' ? BellOff : BellRing" class="h-5 w-5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-semibold">{{ state() === "blocked" ? "Notifications are blocked" : title() }}</p>
          <p class="text-sm text-ink-soft">{{ state() === "blocked" ? "Allow notifications for this site in your browser's site settings (the lock icon next to the address), then reload." : text() }}</p>
          @if (state() === "ask") {
            <div class="mt-2 flex gap-2 sm:hidden">
              <button type="button" (click)="turnOn()" [disabled]="busy()" class="h-9 rounded-full bg-peacock px-4 text-sm font-semibold text-white disabled:opacity-60">Turn on</button>
              <button type="button" (click)="later()" class="h-9 rounded-full px-3 text-sm font-semibold text-ink-soft">Not now</button>
            </div>
          }
        </div>
        @if (state() === "ask") {
          <div class="hidden shrink-0 gap-2 sm:flex">
            <button type="button" (click)="later()" class="h-9 rounded-full px-3 text-sm font-semibold text-ink-soft hover:bg-mist">Not now</button>
            <button type="button" (click)="turnOn()" [disabled]="busy()" class="h-9 rounded-full bg-peacock px-4 text-sm font-semibold text-white hover:bg-peacock-dark disabled:opacity-60" data-testid="push-enable">Turn on</button>
          </div>
        }
        <button type="button" (click)="later()" class="shrink-0 rounded-full p-1 text-ink-faint hover:bg-white/60" aria-label="Close"><svg [pcIcon]="X" class="h-4 w-4" /></button>
      </div>
    }
  `,
})
export class PushPrompt implements OnInit {
  readonly app = input.required<PushApp>();
  readonly title = input.required<string>();
  readonly text = input.required<string>();
  readonly showBlocked = input(false);
  /** the reference's className */
  readonly extraClass = input<string>("");
  private readonly toast = inject(Toast);
  protected readonly state = signal<"hidden" | "ask" | "blocked">("hidden");
  protected readonly busy = signal(false);
  protected readonly BellOff = BellOff;
  protected readonly BellRing = BellRing;
  protected readonly X = X;
  protected readonly boxCls = computed(() => cx("flex items-start gap-3 rounded-2xl p-3.5 shadow-sm ring-1 sm:items-center",
    this.state() === "blocked" ? "bg-vermilion-light ring-vermilion/30" : "bg-white ring-peacock/20", this.extraClass()));

  private live = true;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.live = false; });
  }

  ngOnInit(): void {
    void (async () => {
      const app = this.app();
      const cfg = await pushConfig();
      if (!cfg.enabled) return;
      const perm = await pushPermission();
      if (perm === "granted") {
        void enablePush(app, false); // keep this device's token fresh
        return;
      }
      if (perm === "unsupported" || Date.now() - dismissedAt(app) < WEEK) return;
      if (this.live) this.state.set(perm === "denied" ? (this.showBlocked() ? "blocked" : "hidden") : "ask");
    })().catch(() => {});
  }

  protected later(): void {
    try {
      localStorage.setItem(`pc_push_later_${this.app()}`, String(Date.now()));
    } catch {
      /* private mode */
    }
    this.state.set("hidden");
  }

  protected async turnOn(): Promise<void> {
    this.busy.set(true);
    const r = await enablePush(this.app(), true);
    this.busy.set(false);
    if (r === "on") {
      this.toast.show("Notifications are on for this device");
      this.state.set("hidden");
    } else if (r === "denied") {
      this.state.set(this.showBlocked() ? "blocked" : "hidden");
    } else if (r === "unsupported") {
      this.toast.show("This browser cannot show notifications. Try Chrome, or install the app.", "error");
      this.state.set("hidden");
    } else if (r === "error") {
      this.toast.show("Could not turn on notifications. Try again later.", "error");
    }
  }
}
