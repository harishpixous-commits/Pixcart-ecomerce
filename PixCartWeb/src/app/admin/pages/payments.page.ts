/* Admin → Payments: gateway order, failover and strategy, last-24-hour health and a Test connection button.
 * Mirrors /api/admin/payments/* in both the .NET and the Python versions. Keys are entered on Admin → Integrations. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Toast } from "../../shared/ui/ui";

type Gateway = { code: string; name: string; configured: boolean; enabled: boolean; mode: string; currencies: string[]; client_mode: string; circuit: string; attempts: number; ok: number; success_rate: number | null; avg_ms: number | null; p95_ms: number | null; last_error: string; last_error_at: string | null };
type Routing = { order: string[]; failover: boolean; strategy: string; timeout_seconds: number; circuit_failures: number; circuit_cooldown_seconds: number; window_minutes: number; min_samples: number };
type NumberKey = "timeout_seconds" | "circuit_failures" | "circuit_cooldown_seconds" | "window_minutes" | "min_samples";

@Component({
  selector: "pc-admin-payments-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Payments" sub="Order the gateways, set failover and watch the last 24 hours. Enter keys on Integrations first." />
    @if (!r() || !gateways()) { <pc-page-loader /> } @else {
      <form class="flex max-w-4xl flex-col gap-4" (submit)="save($event)">
        @if (error()) { <pc-error-note [message]="error()!" /> }
        <section class="rounded-xl bg-white p-5" data-testid="gateway-order">
          <h2 class="text-lg font-semibold">Gateway order</h2>
          <p class="mb-3 text-sm text-ink-soft">Checkout tries them top to bottom. A gateway that is off or has no keys is skipped.</p>
          @for (code of r()!.order; track code; let i = $index) {
            @if (find(code); as g) {
              <div class="flex flex-wrap items-center gap-3 border-b border-line/50 py-3" [attr.data-testid]="'gateway-' + code">
                <span class="w-6 text-ink-soft">{{ i + 1 }}</span>
                <div class="min-w-40 flex-1">
                  <div class="font-semibold">{{ g.name }} @if (g.mode) { <span class="text-xs text-ink-soft">({{ g.mode }})</span> }</div>
                  <div class="text-xs text-ink-soft">{{ g.enabled ? "On" : g.configured ? "Off" : "No keys" }} · {{ g.client_mode }} · {{ g.currencies.join(", ") }} · {{ g.circuit === "open" ? "paused after failures" : "healthy" }}</div>
                  <div class="text-xs text-ink-soft">{{ stats(g) }}</div>
                  @if (g.last_error) { <div class="text-xs text-red-700">Last error: {{ g.last_error }}</div> }
                  @if (results()[code]) { <div class="text-xs">{{ results()[code] }}</div> }
                </div>
                <button pcButton type="button" variant="ghost" [disabled]="i === 0" (click)="move(code, -1)" [attr.aria-label]="'Move ' + g.name + ' up'">Up</button>
                <button pcButton type="button" variant="ghost" [disabled]="i === r()!.order.length - 1" (click)="move(code, 1)" [attr.aria-label]="'Move ' + g.name + ' down'">Down</button>
                <button pcButton type="button" variant="ghost" [disabled]="testing() === code" (click)="test(code)">{{ testing() === code ? "Testing…" : "Test connection" }}</button>
              </div>
            }
          }
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <label class="flex items-center gap-3 rounded-lg border border-line p-3 sm:col-span-2"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="r()!.failover" (change)="patch({ failover: $any($event.target).checked })" /> <span class="font-semibold">Try the next gateway when one fails</span></label>
          <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">Pick by</span>
            <select class="rounded-lg border border-line px-3 py-2" [value]="r()!.strategy" (change)="patch({ strategy: $any($event.target).value })"><option value="priority">Order above</option><option value="success_rate">Best recent success rate</option></select></label>
          @for (n of numbers; track n[0]) {
            <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">{{ n[1] }}</span>
              <input type="number" class="rounded-lg border border-line px-3 py-2" [value]="r()![n[0]]" (input)="num(n[0], $any($event.target).value)" /></label>
          }
        </section>
        <button pcButton type="submit" class="self-start">Save</button>
      </form>
    }
  `,
})
export class AdminPaymentsPage {
  private readonly toast = inject(Toast);
  protected readonly numbers: [NumberKey, string][] = [["timeout_seconds", "Gateway timeout (seconds)"], ["circuit_failures", "Failures before a gateway is paused"], ["circuit_cooldown_seconds", "Pause length (seconds)"], ["window_minutes", "Look-back window (minutes)"], ["min_samples", "Attempts needed to judge a gateway"]];
  protected readonly gateways = signal<Gateway[] | null>(null);
  protected readonly r = signal<Routing | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly testing = signal<string | null>(null);
  protected readonly results = signal<Record<string, string>>({});

  constructor() {
    api<{ gateways: Gateway[]; routing: Routing }>("/api/admin/payments/gateways").then((x) => { this.gateways.set(x.gateways); this.r.set(x.routing); }).catch(quietly);
  }

  protected find = (code: string): Gateway | undefined => this.gateways()?.find((g) => g.code === code);
  protected stats = (g: Gateway): string => (g.attempts ? `${g.ok}/${g.attempts} ok${g.success_rate !== null ? ` (${Math.round(g.success_rate * 100)}%)` : ""}, avg ${g.avg_ms} ms, p95 ${g.p95_ms} ms` : "No attempts in the last 24 hours");
  protected patch(p: Partial<Routing>): void { this.r.update((c) => (c ? { ...c, ...p } : c)); }
  protected num(k: NumberKey, raw: string): void { this.patch({ [k]: Number(raw) } as Partial<Routing>); }

  protected move(code: string, d: number): void {
    const cur = this.r();
    if (!cur) return;
    const o = [...cur.order];
    const i = o.indexOf(code), j = i + d;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    this.patch({ order: o });
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    try {
      const x = await api<{ routing: Routing; gateways: Gateway[] }>("/api/admin/payments/routing", { method: "PUT", body: this.r() });
      this.r.set(x.routing);
      this.gateways.set(x.gateways);
      this.toast.show("Payment routing saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    }
  }

  protected async test(code: string): Promise<void> {
    this.testing.set(code);
    try {
      const x = await api<{ ok: boolean; ms: number; message: string }>(`/api/admin/payments/gateways/${code}/test`, { method: "POST", body: {} });
      this.results.update((c) => ({ ...c, [code]: (x.ok ? "Connected" : "Failed") + ": " + x.message + (x.ms ? ` (${x.ms} ms)` : "") }));
    } catch (x) {
      this.results.update((c) => ({ ...c, [code]: x instanceof ApiError ? x.message : "Could not test" }));
    } finally {
      this.testing.set(null);
    }
  }
}
