/*
 * Admin → Integrations: payments, SMS, email, WhatsApp, shipping, AI and analytics providers. Each card opens an editor
 * with its fields (secrets are write-only), the on/off switch, saving with the staff member's password (and
 * authenticator code when two-step sign-in is on), a connection test, the webhook address and the setup steps.
 * Port of frontend/src/app/admin/integrations/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { CheckCircle2, CircleDashed, Copy, ExternalLink, KeyRound, PlugZap, Server } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Modal, Pill, Select, TextField, Toast } from "../../shared/ui/ui";

type FieldInfo = {
  key: string; label: string; kind: "text" | "secret" | "email" | "url" | "number" | "select" | "bool"; required: boolean; options: string[]; help: string;
  placeholder: string; pattern_hint: string; min: number | null; max: number | null; set: boolean; source: "admin" | "environment" | ""; undecryptable: boolean;
  hint?: string; value?: string | number | boolean;
};
type Item = {
  key: string; name: string; group: string; purpose: string; docs_url: string; setup_steps: string[]; needed_for_launch: boolean; testable: boolean;
  webhook_url: string; webhook_events: string[]; last_webhook?: { at: string; count: number } | null; enabled: boolean; switch_source: string; ready: boolean; missing: string[]; mode: string; warnings: string[];
  fields: FieldInfo[]; last_test: { ok: boolean; message: string; at: string } | null; updated_at: string | null; updated_by: string;
};
type Infra = { key: string; name: string; ready: boolean; detail: string; how: string };
type D = { environment: string; groups: Record<string, string>; items: Item[]; infrastructure: Infra[] };

@Component({
  selector: "pc-integration-editor",
  imports: [Icon, Button, ErrorNote, Field, Input, Modal, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="true" (close)="close.emit()" [title]="item().name" [wide]="true">
      <div class="grid gap-5 lg:grid-cols-[1fr_280px]">
        <form (submit)="save($event)" class="flex min-w-0 flex-col gap-3">
          <pc-error-note [message]="error()" />
          <label class="flex items-center gap-3 rounded-lg bg-mist px-3 py-2">
            <input type="checkbox" [checked]="enabled()" (change)="enabled.set($any($event.target).checked)" />
            <span class="font-medium">{{ enabled() ? "Switched on" : "Switched off" }}</span>
            <span class="ml-auto text-xs text-ink-faint">{{ item().switch_source === "admin" ? "Set here" : "From server environment" }}</span>
          </label>
          @for (f of item().fields; track f.key) {
            @if (f.kind === "bool") {
              <label class="flex items-start gap-2">
                <input type="checkbox" class="mt-1" [checked]="!!values()[f.key]" (change)="setValue(f.key, $any($event.target).checked)" />
                <span><span class="font-medium">{{ f.label }}</span><span class="block text-xs text-ink-faint">{{ f.help }}</span></span>
              </label>
            } @else if (f.kind === "select") {
              <pc-field [label]="f.label" [hint]="f.help" [for]="fid(f)">
                <select pcSelect [id]="fid(f)" (change)="setValue(f.key, $any($event.target).value)">
                  @for (o of f.options; track o) {<option [value]="o" [selected]="str(f.key) === o">{{ o }}</option>}
                </select>
              </pc-field>
            } @else if (f.kind === "secret") {
              <pc-field [label]="f.label + (f.required ? '' : ' (optional)')" [hint]="hintOf([f.help, sourceNote(f)])" [for]="fid(f)">
                <div class="flex gap-2">
                  <input pcInput [id]="fid(f)" type="password" autocomplete="off" spellcheck="false" [placeholder]="f.set ? 'Saved (' + f.hint + '). Type to replace.' : f.placeholder || 'Paste here'"
                    [value]="secrets()[f.key] ?? ''" (input)="setSecret(f.key, $any($event.target).value)" />
                  @if (f.source === "admin") {
                    <button pcButton type="button" size="sm" variant="secondary" (click)="toggleClear(f.key)">{{ clear().includes(f.key) ? "Keep" : "Remove" }}</button>
                  }
                </div>
              </pc-field>
            } @else {
              <pc-text-field [label]="f.label + (f.required ? '' : ' (optional)')" [type]="f.kind === 'number' ? 'number' : f.kind === 'email' ? 'email' : 'text'"
                [min]="f.min ?? undefined" [max]="f.max ?? undefined" [step]="f.kind === 'number' && (f.max ?? 2) <= 1 ? '0.01' : undefined"
                [placeholder]="f.placeholder" [value]="str(f.key)" (valueChange)="setValue(f.key, $event)"
                [hint]="hintOf([f.help, f.pattern_hint, sourceNote(f)])" autocomplete="off" />
            }
          }
          <div class="grid gap-3 border-t border-line pt-3 md:grid-cols-2">
            <pc-text-field label="Your password" type="password" autocomplete="current-password" [value]="password()" (valueChange)="password.set($event)" [required]="true" hint="Needed to change keys" />
            @if (me()?.totp_enabled) {<pc-text-field label="Authenticator code" inputmode="numeric" [maxlength]="8" [value]="totp()" (valueChange)="totp.set($event)" [required]="true" />}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button pcButton type="submit" [disabled]="busy()"><svg [pcIcon]="I.KeyRound" class="h-4 w-4" />{{ busy() ? "Saving…" : "Save" }}</button>
            @if (item().updated_at) {<span class="text-xs text-ink-faint">Last changed {{ dateTime(item().updated_at) }}{{ item().updated_by ? " by " + item().updated_by : "" }}</span>}
          </div>
          @if (item().testable) {
            <div class="rounded-lg border border-line p-3">
              <p class="mb-2 font-medium">Test connection</p>
              @if (item().key === "msg91" || item().key === "email") {
                <input pcInput class="mb-2" [placeholder]="item().key === 'msg91' ? 'Your 10-digit mobile number' : 'Send a test email to (default: you)'" [value]="testTo()" (input)="testTo.set($any($event.target).value)" aria-label="Test recipient" />
              }
              <button pcButton type="button" variant="secondary" (click)="test()" [disabled]="testing()"><svg [pcIcon]="I.PlugZap" class="h-4 w-4" />{{ testing() ? "Testing…" : "Test with saved settings" }}</button>
              @if (result()) {<p role="status" [class]="result()!.ok ? 'mt-2 text-sm text-leaf' : 'mt-2 text-sm text-red-700'">{{ result()!.message }}</p>}
            </div>
          }
        </form>
        <aside class="flex min-w-0 flex-col gap-3 text-sm">
          @if (item().webhook_url) {
            <div class="rounded-lg bg-mist p-3">
              <p class="font-medium">Webhook address</p>
              <p class="mt-1 flex items-start gap-1 break-all font-mono text-xs">{{ item().webhook_url }}
                <button type="button" (click)="copy(item().webhook_url)" aria-label="Copy webhook address" class="shrink-0 text-peacock"><svg [pcIcon]="I.Copy" class="h-3.5 w-3.5" /></button></p>
              <p class="mt-2 font-medium">Events</p>
              <p class="text-xs text-ink-soft">{{ item().webhook_events.join(", ") }}</p>
              <p class="mt-2 font-medium">Last received</p>
              @if (item().last_webhook; as w) {
                <p class="text-xs text-leaf" data-testid="last-webhook">
                  {{ dateTime(w.at) }} ({{ w.count }} {{ w.count === 1 ? "message" : "messages" }} so far): the webhook works
                </p>
              } @else {
                <p class="text-xs text-ink-soft" data-testid="last-webhook">
                  Nothing yet. After you add the webhook in the provider's dashboard, the first payment shows here.
                </p>
              }
            </div>
          }
          <div>
            <p class="font-medium">How to set it up</p>
            <ol class="mt-1 list-decimal space-y-1 pl-5 text-ink-soft">@for (s of item().setup_steps; track s) {<li>{{ s }}</li>}</ol>
            <a class="mt-2 inline-flex items-center gap-1 text-peacock underline" [href]="item().docs_url" target="_blank" rel="noreferrer">Provider guide<svg [pcIcon]="I.ExternalLink" class="h-3.5 w-3.5" /></a>
          </div>
          @if (item().missing.length > 0) {<p class="text-amber-700">Still needed: {{ item().missing.join(", ") }}</p>}
        </aside>
      </div>
    </pc-modal>
  `,
})
export class IntegrationEditor {
  readonly item = input.required<Item>();
  readonly close = output<void>();
  /** awaited before the Save button is released, like the reference (the list reloads while it still says Saving…) */
  readonly onSaved = input.required<(msg: string) => Promise<void>>();
  private readonly admin = inject(AdminContext);
  protected readonly me = this.admin.me;
  protected readonly I = { KeyRound, PlugZap, Copy, ExternalLink };
  protected readonly dateTime = dateTime;
  protected readonly values = signal<Record<string, string | number | boolean>>({});
  protected readonly secrets = signal<Record<string, string | undefined>>({});
  protected readonly clear = signal<string[]>([]);
  protected readonly enabled = signal(false);
  protected readonly password = signal("");
  protected readonly totp = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly testTo = signal("");
  protected readonly testing = signal(false);
  protected readonly result = signal<{ ok: boolean; message: string; at: string } | null>(null);

  ngOnInit(): void {
    const item = this.item();
    this.values.set(Object.fromEntries(item.fields.filter((f) => f.kind !== "secret").map((f) => [f.key, f.value ?? ""])));
    this.enabled.set(item.enabled);
    this.result.set(item.last_test);
  }

  protected fid(f: FieldInfo): string {
    return `int-${this.item().key}-${f.key}`;
  }

  protected str(k: string): string {
    return String(this.values()[k] ?? "");
  }

  protected sourceNote(f: FieldInfo): string {
    return f.source === "admin" ? "Saved here" : f.source === "environment" ? "From server environment" : f.undecryptable ? "Saved value can no longer be read — enter it again" : "";
  }

  protected hintOf(parts: string[]): string {
    return parts.filter(Boolean).join(" · ");
  }

  protected setValue(k: string, v: string | boolean): void {
    this.values.update((x) => ({ ...x, [k]: v }));
  }

  protected setSecret(k: string, v: string): void {
    this.secrets.update((x) => ({ ...x, [k]: v }));
  }

  protected toggleClear(k: string): void {
    this.clear.update((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const item = this.item();
    this.error.set(null);
    this.busy.set(true);
    const values = this.values(), secrets = this.secrets();
    const changed: Record<string, unknown> = {};
    for (const f of item.fields) {
      if (f.kind === "secret") { const sv = secrets[f.key]?.trim(); if (sv) changed[f.key] = sv; }
      else if (values[f.key] !== (f.value ?? "") && !(values[f.key] === "" && !f.set)) changed[f.key] = f.kind === "number" ? Number(values[f.key]) : values[f.key];
    }
    try {
      const r = await api<{ changed: string[] }>(`/api/admin/integrations/${item.key}`, { method: "PUT", body: { values: changed, clear: this.clear(), enabled: this.enabled(), password: this.password(), totp: this.totp() } });
      this.secrets.set({});
      this.password.set("");
      this.totp.set("");
      this.clear.set([]);
      await this.onSaved()(r.changed.length ? `${item.name} saved` : "Nothing changed");
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }

  protected async test(): Promise<void> {
    const item = this.item();
    this.testing.set(true);
    this.error.set(null);
    try {
      const body = item.key === "msg91" ? { phone: this.testTo() } : item.key === "email" ? { to: this.testTo() } : {};
      this.result.set(await api<{ ok: boolean; message: string; at: string }>(`/api/admin/integrations/${item.key}/test`, { method: "POST", body }));
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Test failed");
    } finally {
      this.testing.set(false);
    }
  }

  protected copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}

@Component({
  selector: "pc-admin-integrations-page",
  imports: [PageHeader, Icon, PageLoader, Pill, IntegrationEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-5">
        <pc-page-header title="Integrations"
          sub="Connect payments, SMS, email, WhatsApp, shipping, AI and analytics. Keys are encrypted before they are saved and are never shown again. Server environment values are used until you save your own."
          [withActions]="true">
          <pc-pill actions [tone]="d()!.environment === 'production' ? 'green' : 'blue'">{{ d()!.environment }}</pc-pill><pc-pill actions tone="gray">{{ live() }}/{{ d()!.items.length }} connected</pc-pill>
        </pc-page-header>
        @for (g of groups(); track g[0]) {
          @if (inGroup(g[0]).length) {
            <section>
              <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">{{ g[1] }}</h2>
              <div class="grid gap-3 md:grid-cols-2">
                @for (i of inGroup(g[0]); track i.key) {
                  <button [id]="i.key" (click)="open.set(i)" class="min-w-0 rounded-xl bg-white p-4 text-left ring-peacock/40 transition hover:ring-2 focus-visible:ring-2">
                    <div class="flex items-center gap-2">
                      @if (i.ready) {<svg [pcIcon]="I.CheckCircle2" class="h-5 w-5 shrink-0 text-leaf" />} @else {<svg [pcIcon]="I.CircleDashed" class="h-5 w-5 shrink-0 text-ink-faint" />}
                      <span class="truncate text-lg font-semibold">{{ i.name }}</span>
                      <span class="ml-auto flex shrink-0 items-center gap-1">
                        @if (i.mode) {<pc-pill [tone]="i.mode === 'live' ? 'green' : 'amber'">{{ i.mode === "live" ? "Live keys" : "Test keys" }}</pc-pill>}
                        @if (i.needed_for_launch && !i.ready) {<pc-pill tone="red">Needed for launch</pc-pill>}
                        <pc-pill [tone]="i.ready ? 'green' : i.enabled ? 'amber' : 'gray'">{{ i.ready ? "On" : i.enabled ? "Incomplete" : "Off" }}</pc-pill>
                      </span>
                    </div>
                    <p class="mt-1 text-sm text-ink-soft">{{ i.purpose }}</p>
                    @if (i.last_test) {<p [class]="i.last_test.ok ? 'mt-2 text-xs text-leaf' : 'mt-2 text-xs text-red-700'">Last test: {{ i.last_test.message }}</p>}
                    @for (w of i.warnings; track w) {<p class="mt-1 text-xs text-amber-700">{{ w }}</p>}
                  </button>
                }
              </div>
            </section>
          }
        }
        <section>
          <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">Set on the servers (Terraform)</h2>
          <div class="grid gap-3 md:grid-cols-3">
            @for (x of d()!.infrastructure; track x.key) {
              <div class="rounded-xl bg-white p-4">
                <p class="flex items-center gap-2 font-semibold"><svg [pcIcon]="I.Server" class="h-4 w-4 text-ink-faint" />{{ x.name }}<span class="ml-auto">@if (x.ready) {<pc-pill tone="green">Ready</pc-pill>} @else {<pc-pill tone="gray">Not yet</pc-pill>}</span></p>
                <p class="mt-1 break-all text-sm text-ink-soft">{{ x.detail }}</p>
                <p class="mt-1 text-xs text-ink-faint">{{ x.how }}</p>
              </div>
            }
          </div>
        </section>
        @if (open(); as o) {
          <pc-integration-editor [item]="current(o)" (close)="closeEditor()" [onSaved]="savedFn" />
        }
      </div>
    }
  `,
})
export class AdminIntegrationsPage {
  private readonly toast = inject(Toast);
  protected readonly I = { CheckCircle2, CircleDashed, Server };
  protected readonly d = signal<D | null>(null);
  protected readonly open = signal<Item | null>(null);
  private hashOpened = false;
  protected readonly groups = computed(() => Object.entries(this.d()?.groups ?? {}));
  protected readonly live = computed(() => (this.d()?.items ?? []).filter((i) => i.ready).length);

  constructor() {
    void this.load();
  }

  protected load(): Promise<void> {
    return api<D>("/api/admin/integrations")
      .then((x) => {
        this.d.set(x);
        // a link like /admin/integrations#firebase opens that provider once the list has loaded
        if (!this.hashOpened) {
          this.hashOpened = true;
          const it = x.items.find((i) => i.key === window.location.hash.slice(1));
          if (it) this.open.set(it);
        }
      })
      .catch(quietly);
  }

  protected inGroup(g: string): Item[] {
    return (this.d()?.items ?? []).filter((i) => i.group === g);
  }

  /** the open provider as last loaded (fresh after saving) */
  protected current(o: Item): Item {
    return this.d()?.items.find((i) => i.key === o.key) ?? o;
  }

  protected closeEditor(): void {
    this.open.set(null);
    // drops the #provider part like the reference replaceState(null, "", " "); spelled out because this app has
    // <base href="/">, which would resolve " " to the home page
    history.replaceState(history.state, "", location.pathname + location.search);
  }

  protected readonly savedFn = (msg: string) => this.onSaved(msg);

  protected async onSaved(msg: string): Promise<void> {
    this.toast.show(msg);
    await this.load();
  }
}
