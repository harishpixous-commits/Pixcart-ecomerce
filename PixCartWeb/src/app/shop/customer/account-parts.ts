/*
 * The sections of the shopper's Account page besides the profile and addresses:
 *   <pc-signed-in-devices />   where the account is signed in, and "Sign out other devices" (components/signed-in-devices.tsx)
 *   <pc-saved-cards />         cards Razorpay saved for the shopper (components/saved-cards.tsx)
 *   <pc-privacy-section>       marketing consent, "Download my data" and "Delete my account" (account/page.tsx)
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { CreditCard, Laptop, LogOut, ShieldCheck, Smartphone } from "lucide-angular";
import { ApiError, api, quietly, refreshSession } from "../../core/api";
import { dateTime } from "../../core/format";
import { SessionService } from "../../core/session";
import { NETWORK_NAMES, PayLogo, networkKey } from "../../shared/chrome/pay-logos";
import { Icon } from "../../shared/ui/icon";
import { Button, ErrorNote, Modal, Spinner, TextField, Toast } from "../../shared/ui/ui";

/* ---------------------------------------------------------------- signed-in devices */

/*
 * Signed-in devices: where this account is signed in, and one button to sign every other device out (a lost phone,
 * a shared computer). This device stays signed in.
 */

type Device = { id: string; device: string; last_active: string; expires_at: string; current: boolean };

const PHONE = /Android|iPhone|iPad|Partner app/;

@Component({
  selector: "pc-signed-in-devices",
  imports: [Icon, Button, ErrorNote, Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl bg-white p-5" aria-labelledby="devices-h" data-testid="signed-in-devices">
      <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="devices-h" class="text-lg font-semibold">Signed-in devices</h2>
          <p class="text-sm text-ink-soft">Where your account is signed in now. Sign the others out if you lost a phone or used a shared computer.</p>
        </div>
        <button pcButton variant="secondary" size="sm" [disabled]="others() === 0" (click)="confirm.set(true)" data-testid="sign-out-others">
          <svg [pcIcon]="LogOut" class="h-4 w-4" /> Sign out other devices
        </button>
      </div>
      @if (rows() === null) {
        <ul class="space-y-2" aria-hidden="true">@for (i of [0, 1]; track i) {<li class="h-12 animate-pulse rounded-lg bg-mist"></li>}</ul>
      } @else {
        <ul class="divide-y divide-line">
          @for (r of rows(); track r.id) {
            <li class="flex items-center gap-3 py-2.5">
              <svg [pcIcon]="phone(r.device) ? Smartphone : Laptop" class="h-5 w-5 shrink-0 text-ink-soft" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">{{ r.device }} @if (r.current) {<span class="ml-1 rounded-full bg-leaf-light px-2 text-xs font-bold leading-5 text-leaf">This device</span>}</p>
                <p class="text-xs text-ink-faint">Last active {{ dateTime(r.last_active) }}</p>
              </div>
            </li>
          }
          @if (rows()!.length === 0) {<li class="py-2 text-sm text-ink-soft">No other devices.</li>}
        </ul>
      }
      <pc-modal [open]="confirm()" (close)="confirm.set(false)" title="Sign out other devices?">
        <p class="text-ink-soft">{{ others() === 1 ? "1 other device" : others() + " other devices" }} will be signed out straight away and must sign in again. This device stays signed in.</p>
        <pc-error-note [message]="error()" />
        <div class="mt-4 flex justify-end gap-2">
          <button pcButton variant="ghost" (click)="confirm.set(false)">Cancel</button>
          <button pcButton [loading]="busy()" (click)="signOutOthers()" data-testid="sign-out-others-confirm">Sign them out</button>
        </div>
      </pc-modal>
    </section>
  `,
})
export class SignedInDevices {
  private readonly toast = inject(Toast);
  protected readonly rows = signal<Device[] | null>(null);
  protected readonly confirm = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly others = computed(() => (this.rows() ?? []).filter((r) => !r.current).length);
  protected readonly dateTime = dateTime;
  protected readonly phone = (d: string) => PHONE.test(d);
  protected readonly LogOut = LogOut;
  protected readonly Smartphone = Smartphone;
  protected readonly Laptop = Laptop;

  constructor() {
    void this.load();
  }

  private load(): Promise<void> {
    return api<{ sessions: Device[] }>("/api/auth/sessions").then((r) => this.rows.set(r.sessions)).catch(quietly);
  }

  protected async signOutOthers(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ signed_out: number }>("/api/auth/sessions/sign-out-others", { method: "POST" });
      await refreshSession(); // this device renews its access with its own session, which was kept
      this.confirm.set(false);
      this.toast.show(r.signed_out === 1 ? "1 other device was signed out" : `${r.signed_out} other devices were signed out`);
      await this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not sign the other devices out. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- saved cards */

/*
 * Account → Saved cards. Cards are saved by Razorpay, inside its payment window, when the shopper ticks "Save this card"
 * (RBI card-on-file tokenisation): the card network keeps a token, and neither this site nor Razorpay keeps the card
 * number. Here they see the last 4 digits, network and expiry, and can remove a card.
 */

type SavedCard = {
  id: string; last4: string; network: string; issuer: string; type: string; name: string;
  expiry_month: number | null; expiry_year: number | null; international: boolean; used_at: number | null;
};

@Component({
  selector: "pc-saved-cards",
  imports: [Icon, Button, Modal, Spinner, PayLogo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (enabled() || cards()?.length) {
      <section class="rounded-xl bg-white p-5" data-testid="saved-cards" aria-labelledby="cards-h">
        <h2 id="cards-h" class="mb-1 flex items-center gap-2 text-xl font-semibold"><svg [pcIcon]="CreditCard" class="h-5 w-5 text-peacock" /> Saved cards</h2>
        <p class="mb-3 flex items-start gap-1.5 text-sm text-ink-soft">
          <svg [pcIcon]="ShieldCheck" class="mt-0.5 h-4 w-4 shrink-0 text-leaf" />
          Saved securely by Razorpay as RBI requires: your card number is never stored on this site. To save a card, tick
          &quot;Save this card&quot; when you pay. You confirm each payment with your CVV and your bank&apos;s OTP.
        </p>
        @if (cards() === null) {
          <svg pcSpinner />
        } @else if (error()) {
          <p class="text-sm text-vermilion" role="alert">{{ error() }}</p>
        } @else if (cards()!.length === 0) {
          <p class="rounded-lg bg-mist px-3 py-3 text-sm text-ink-soft">No saved cards yet.</p>
        } @else {
          <ul class="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            @for (c of cards(); track c.id) {
              <li class="flex min-w-0 items-center gap-3 rounded-xl p-3 ring-1 ring-line" data-testid="saved-card">
                <pc-pay-logo [name]="key(c)" logoClass="h-9 w-14" />
                <div class="min-w-0 flex-1">
                  <p class="font-semibold" translate="no">{{ names[key(c)] ?? c.network }} •••• {{ c.last4 }}</p>
                  <p class="truncate text-sm text-ink-soft">{{ meta(c) }}</p>
                </div>
                <button pcButton variant="ghost" size="sm" (click)="removing.set(c)">Remove</button>
              </li>
            }
          </ul>
        }
        <pc-modal [open]="!!removing()" (close)="removing.set(null)" title="Remove this card?">
          <p class="text-ink-soft">@if (removing(); as r) {The card ending <span class="font-semibold text-ink" translate="no">{{ r.last4 }}</span> will no longer be offered when you pay. You can save it again next time.}</p>
          <div class="mt-4 flex justify-end gap-2">
            <button pcButton variant="ghost" (click)="removing.set(null)">Keep it</button>
            <button pcButton variant="danger" (click)="remove()" [loading]="busy()">Remove card</button>
          </div>
        </pc-modal>
      </section>
    }
  `,
})
export class SavedCards {
  private readonly toast = inject(Toast);
  protected readonly cards = signal<SavedCard[] | null>(null);
  protected readonly enabled = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly removing = signal<SavedCard | null>(null);
  protected readonly busy = signal(false);
  protected readonly names: Record<string, string | undefined> = NETWORK_NAMES;
  protected readonly CreditCard = CreditCard;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly key = (c: SavedCard) => networkKey(c.network);

  constructor() {
    this.load();
  }

  private load(): void {
    api<{ enabled: boolean; items: SavedCard[] }>("/api/account/cards")
      .then((r) => {
        this.cards.set(r.items);
        this.enabled.set(r.enabled);
        this.error.set(null);
      })
      .catch((e) => {
        this.cards.set([]);
        this.error.set(e instanceof ApiError ? e.message : "Could not load your saved cards");
      });
  }

  protected meta(c: SavedCard): string {
    const exp = c.expiry_month && c.expiry_year ? `${String(c.expiry_month).padStart(2, "0")}/${String(c.expiry_year).slice(-2)}` : "";
    return [c.issuer, c.type && `${c.type} card`, exp && `expires ${exp}`].filter(Boolean).join(" · ");
  }

  protected async remove(): Promise<void> {
    const r = this.removing();
    if (!r) return;
    this.busy.set(true);
    try {
      await api(`/api/account/cards/${r.id}`, { method: "DELETE" });
      this.toast.show("Card removed");
      this.removing.set(null);
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not remove the card", "error");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- privacy and data */

@Component({
  selector: "pc-privacy-section",
  imports: [Button, ErrorNote, Modal, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-3 text-xl font-semibold">Privacy and data</h2>
      <label class="flex items-start gap-3">
        <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="marketing()" (change)="consent($event)" />
        <span>Send me offers and deals by SMS, WhatsApp and email. Order updates are always sent.</span>
      </label>
      <div class="mt-4 flex flex-wrap gap-2">
        <button pcButton variant="secondary" size="sm" (click)="download()">Download my data</button>
        <button pcButton variant="danger" size="sm" (click)="confirm.set(true)">Delete my account</button>
      </div>
      <pc-modal [open]="confirm()" (close)="confirm.set(false)" title="Delete your account?">
        <p class="mb-3 text-ink-soft">Your profile, addresses and wishlist are erased and you are signed out everywhere. Invoices and order records are kept for the period the GST law requires, without your name or contact details on your account.</p>
        <pc-error-note [message]="error()" />
        <pc-text-field label='Type "DELETE" to confirm' [(value)]="typed" />
        <button pcButton class="mt-3" variant="buy" [disabled]="typed() !== 'DELETE'" (click)="remove()">Delete my account</button>
      </pc-modal>
    </section>
  `,
})
export class PrivacySection {
  readonly marketing = input(false);
  readonly deleted = output<void>();
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  protected readonly confirm = signal(false);
  protected readonly typed = signal("");
  protected readonly error = signal<string | null>(null);

  protected async consent(e: Event): Promise<void> {
    await api("/api/account/consent", { method: "PUT", body: { marketing_opt_in: (e.target as HTMLInputElement).checked } });
    await this.session.reloadUser();
    this.toast.show("Saved");
  }

  protected async download(): Promise<void> {
    const data = await api("/api/account/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "my-pixcart-data.json";
    a.click();
  }

  protected async remove(): Promise<void> {
    this.error.set(null);
    try {
      await api("/api/account", { method: "DELETE" });
      this.toast.show("Your account has been deleted");
      this.deleted.emit();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not delete the account");
    }
  }
}
