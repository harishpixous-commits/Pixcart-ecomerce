/* Contact support: a new request (optionally about an order, or as a formal grievance). Port of frontend/src/app/(shop)/support/new/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { ApiError, api, quietly } from "../../core/api";
import { SessionService } from "../../core/session";
import { Button, ErrorNote, Field, Select, TextField, Textarea } from "../../shared/ui/ui";

type Form = { category: string; subject: string; message: string; is_grievance: boolean };

@Component({
  selector: "pc-shop-support-new-page",
  imports: [Button, ErrorNote, Field, Select, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="mx-auto flex max-w-2xl flex-col gap-4 rounded-xl bg-white p-6">
      <h1 class="text-2xl font-semibold">Contact support</h1>
      @if (orderId) {<p class="text-sm text-ink-soft">About your order. We will see its details.</p>}
      <pc-error-note [message]="error()" />
      <pc-field label="What is it about?" for="cat">
        <select pcSelect id="cat" (change)="patch({ category: $any($event.target).value })">
          @for (c of cats(); track c.code) {<option [value]="c.code" [selected]="c.code === f().category">{{ c.label }}</option>}
        </select>
      </pc-field>
      <pc-text-field label="Subject" [value]="f().subject" (valueChange)="patch({ subject: $event })" [minlength]="5" [maxlength]="200" [required]="true" />
      <pc-field label="Tell us what happened" for="msg">
        <textarea pcTextarea id="msg" [value]="f().message" (input)="patch({ message: $any($event.target).value })" minlength="10" maxlength="5000" rows="6" required></textarea>
      </pc-field>
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" class="mt-1 accent-peacock" [checked]="f().is_grievance" (change)="patch({ is_grievance: $any($event.target).checked })" />
        <span>Raise this as a formal grievance under the Consumer Protection (E-Commerce) Rules. It goes to our grievance officer, who acknowledges within 48 hours and resolves within one month.</span>
      </label>
      <button pcButton type="submit" [loading]="busy()" class="self-start">Send request</button>
    </form>
  `,
})
export class ShopSupportNewPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly sp = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly orderId = this.sp.get("order");
  protected readonly cats = signal<{ code: string; label: string }[]>([]);
  protected readonly f = signal<Form>({ category: this.sp.get("category") ?? "order", subject: this.sp.get("subject") ?? "", message: "", is_grievance: this.sp.get("grievance") === "1" });
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      if (this.session.ready() && !this.session.user())
        void this.router.navigateByUrl(`/login?next=${encodeURIComponent("/support/new" + (this.orderId ? `?order=${this.orderId}` : ""))}`, { replaceUrl: true });
    });
    api<{ categories: { code: string; label: string }[] }>("/api/support/categories").then((r) => this.cats.set(r.categories)).catch(quietly);
  }

  protected patch(p: Partial<Form>): void {
    this.f.update((f) => ({ ...f, ...p }));
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const t = await api<{ id: string }>("/api/support/tickets", { method: "POST", body: { ...this.f(), order_id: this.orderId || undefined } });
      void this.router.navigateByUrl(`/support/${t.id}`, { replaceUrl: true });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not send your request");
      this.busy.set(false);
    }
  }
}
