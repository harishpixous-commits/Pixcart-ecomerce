/*
 * Admin → Customer and seller messages: the template for every event and channel (in the app, email, SMS, WhatsApp),
 * with the variables filled in automatically, the provider template id, on/off, and delivery counts.
 * Port of frontend/src/app/admin/notifications/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { PageHeader, Stat } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Pill, Textarea, TextField, Toast } from "../../shared/ui/ui";

type T = { event: string; channel: "inapp" | "email" | "sms" | "whatsapp"; customised: boolean; subject: string; body: string; provider_template: string; is_active: boolean };
type D = { items: T[]; delivery: Record<string, number>; channels: { email: boolean; sms: boolean; whatsapp: boolean } };

const CHANNEL: Record<string, string> = { inapp: "In the app", email: "Email", sms: "SMS", whatsapp: "WhatsApp" };
const EVENT: Record<string, string> = {
  order_placed: "Order placed", order_shipped: "Order shipped", order_delivered: "Order delivered", order_cancelled: "Order cancelled",
  refund_processed: "Refund processed", return_update: "Return status changed", ticket_reply: "Support replied",
  seller_new_order: "Seller: new order", seller_order_cancelled: "Seller: order cancelled", seller_return_requested: "Seller: return requested",
  seller_kyc_update: "Seller: verification result", listing_update: "Seller: listing reviewed", payout_sent: "Seller: payout sent", low_stock: "Seller: low stock",
};
const label = (e: string) => EVENT[e] ?? e.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

@Component({
  selector: "pc-admin-notifications-page",
  imports: [PageHeader, Stat, PageLoader, Button, ErrorNote, Field, Pill, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Customer and seller messages" sub="What we send when something happens to an order, return or account. Order updates are always sent; offers only to people who agreed." />
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
          @for (c of channels; track c) {<pc-stat [label]="channel[c]" [value]="d()!.channels[c] ? 'Connected' : 'Not set up'" [hint]="d()!.channels[c] ? undefined : 'Add keys in the server settings'" />}
          <pc-stat label="Sent" [value]="(d()!.delivery['sent'] ?? 0).toLocaleString('en-IN')" />
          <pc-stat label="Failed" [value]="(d()!.delivery['failed'] ?? 0).toLocaleString('en-IN')" [hint]="d()!.delivery['pending'] ? d()!.delivery['pending'] + ' waiting' : undefined" />
        </div>
        <div class="grid gap-4 lg:grid-cols-[280px_1fr]">
          <aside class="max-h-[70vh] self-start overflow-auto rounded-xl bg-white p-2">
            @for (e of events(); track e) {
              <div class="mb-1">
                <p class="px-2 pt-2 text-sm font-semibold">{{ label(e) }}</p>
                <div class="flex flex-wrap gap-1 px-2 pb-1">
                  @for (t of forEvent(e); track t.channel) {
                    <button (click)="pick(t)" [class]="chipCls(t)">{{ channel[t.channel] }}</button>
                  }
                </div>
              </div>
            }
          </aside>
          @if (f(); as f) {
            <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-lg font-semibold">{{ label(f.event) }}, {{ channel[f.channel] }}</h2>
                @if (f.customised) {<pc-pill tone="blue">Edited</pc-pill>} @else {<pc-pill tone="gray">Default text</pc-pill>}
              </div>
              <pc-error-note [message]="error()" />
              @if (f.channel === "email") {<pc-text-field label="Subject" [value]="f.subject" (valueChange)="patch({ subject: $event })" [maxlength]="200" />}
              <pc-field label="Message" [hint]="f.channel === 'sms' ? 'SMS in India must match a DLT-approved template word for word. Keep this text identical to your approved template.' : undefined">
                <textarea pcTextarea rows="7" [value]="f.body" (input)="patch({ body: $any($event.target).value })" maxlength="5000"></textarea>
              </pc-field>
              @if (vars().length > 0) {<p class="text-sm text-ink-soft">Filled in automatically: {{ vars().join(", ") }}</p>}
              @if (f.channel === "sms" || f.channel === "whatsapp") {
                <pc-text-field [label]="f.channel === 'sms' ? 'MSG91 flow ID' : 'WhatsApp template name'" [value]="f.provider_template" (valueChange)="patch({ provider_template: $event })"
                  [hint]="f.channel === 'sms' ? 'From MSG91 → Flow, linked to the DLT template' : 'Approved template name in Meta WhatsApp Manager. Its variables are filled in the order they appear above.'" />
              }
              <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="f.is_active" (change)="patch({ is_active: $any($event.target).checked })" /> Send this message</label>
              <button pcButton class="self-start" (click)="save()">Save template</button>
            </section>
          }
        </div>
      </div>
    }
  `,
})
export class AdminNotificationsPage {
  private readonly toast = inject(Toast);
  protected readonly channel = CHANNEL;
  protected readonly channels = ["email", "sms", "whatsapp"] as const;
  protected readonly label = label;
  protected readonly d = signal<D | null>(null);
  protected readonly sel = signal<{ event: string; channel: string } | null>(null);
  protected readonly f = signal<T | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly events = computed(() => Array.from(new Set(this.d()?.items.map((t) => t.event) ?? [])));
  protected readonly vars = computed(() => {
    const f = this.f();
    return f ? Array.from(new Set((f.body + " " + f.subject).match(/\{\{[a-z_]+\}\}/g) ?? [])) : [];
  });

  constructor() {
    this.load().then((x) => {
      const t = x.items[0];
      if (t) {
        this.sel.set(t);
        this.f.set(t);
      }
    }).catch(quietly);
  }

  private load(): Promise<D> {
    return api<D>("/api/admin/notifications/templates").then((x) => {
      this.d.set(x);
      return x;
    });
  }

  protected forEvent(e: string): T[] {
    return (this.d()?.items ?? []).filter((t) => t.event === e);
  }

  protected chipCls(t: T): string {
    const s = this.sel();
    return `rounded-full px-2.5 py-0.5 text-xs ${s?.event === t.event && s.channel === t.channel ? "bg-peacock text-white" : t.is_active ? "bg-peacock-light text-peacock" : "bg-mist text-ink-faint"}`;
  }

  protected pick(t: T): void {
    this.sel.set(t);
    this.f.set(t);
    this.error.set(null);
  }

  protected patch(x: Partial<T>): void {
    this.f.update((f) => (f ? { ...f, ...x } : f));
  }

  protected async save(): Promise<void> {
    const f = this.f();
    if (!f) return;
    this.error.set(null);
    try {
      await api(`/api/admin/notifications/templates/${f.event}/${f.channel}`, { method: "PUT", body: { subject: f.subject, body: f.body, provider_template: f.provider_template, is_active: f.is_active } });
      this.toast.show("Template saved");
      this.load().catch(quietly);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    }
  }
}
