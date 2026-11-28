/*
 * The footer newsletter box. Shows only when Admin → Growth → Newsletter is switched on. Port of components/newsletter.tsx.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiError, api, quietly } from "../../core/api";
import { Button, Input, Toast } from "../ui/ui";

@Component({
  selector: "pc-newsletter-box",
  imports: [Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (box(); as b) {
      @if (b.enabled) {
        <section aria-label="Newsletter" data-testid="newsletter-box" class="border-t border-line bg-mist">
          <form (submit)="join($event)" class="mx-auto flex w-full max-w-shop flex-col items-start gap-3 px-3 py-5 sm:flex-row sm:items-center sm:px-4">
            <p class="font-semibold text-ink sm:flex-1">{{ b.title }}</p>
            @if (done()) {
              <p class="text-sm font-semibold text-leaf" role="status">Thanks. You are on the list.</p>
            } @else {
              <div class="flex w-full gap-2 sm:w-auto">
                <input pcInput type="email" required [value]="email()" (input)="email.set($any($event.target).value)" placeholder="Your email" aria-label="Email address" class="sm:w-72" />
                <button pcButton type="submit" [loading]="busy()">Sign up</button>
              </div>
            }
          </form>
        </section>
      }
    }
  `,
})
export class NewsletterBox {
  private readonly toast = inject(Toast);
  protected readonly box = signal<{ enabled: boolean; title: string } | null>(null);
  protected readonly email = signal("");
  protected readonly busy = signal(false);
  protected readonly done = signal(false);

  constructor() {
    api<{ enabled: boolean; title: string }>("/api/newsletter").then((x) => this.box.set(x)).catch(quietly);
  }

  protected async join(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    try {
      await api("/api/newsletter", { method: "POST", body: { email: this.email() } });
      this.done.set(true);
      this.email.set("");
    } catch (err) {
      this.toast.show(err instanceof ApiError ? err.message : "Could not sign you up. Try again.", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
