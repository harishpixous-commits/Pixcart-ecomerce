/*
 * Account: profile (name, email for invoices), sign out, signed-in devices, privacy and data (consent, download, delete the
 * account), saved addresses and saved cards. Port of frontend/src/app/(shop)/account/page.tsx.
 */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { MapPin } from "lucide-angular";
import { ApiError, api, quietly } from "../../core/api";
import { SessionService } from "../../core/session";
import type { Address } from "../../core/types";
import { AddressForm } from "../../shared/commerce/address-form";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Pill, TextField, Toast } from "../../shared/ui/ui";
import { PrivacySection, SavedCards, SignedInDevices } from "../customer/account-parts";

const KIND: Record<Address["kind"], string> = { home: "Home", work: "Work", other: "Other" };

@Component({
  selector: "pc-shop-account-page",
  imports: [Icon, PageLoader, Button, ErrorNote, Pill, TextField, AddressForm, PrivacySection, SavedCards, SignedInDevices],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.user() || !addresses()) {
      <pc-page-loader />
    } @else {
      @let user = session.user()!;
      <div class="mx-auto flex max-w-3xl flex-col gap-4">
        <section class="rounded-xl bg-white p-5">
          <h1 class="mb-4 text-2xl font-semibold">Your profile</h1>
          <form (submit)="saveProfile($event)" class="grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>
            <pc-text-field label="Name" [(value)]="name" [required]="true" />
            <pc-text-field label="Email (for invoices)" type="email" [(value)]="email" />
            <p class="text-sm text-ink-soft sm:col-span-2">Signed in with mobile +91 {{ user.phone }}</p>
            <div class="flex gap-2 sm:col-span-2">
              <button pcButton type="submit" [loading]="saving()">Save profile</button>
              <button pcButton type="button" variant="ghost" (click)="signOut()">Sign out</button>
            </div>
          </form>
        </section>
        <pc-signed-in-devices />
        <pc-privacy-section [marketing]="user.marketing_opt_in ?? false" (deleted)="signOut()" />
        <section class="rounded-xl bg-white p-5">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-xl font-semibold">Saved addresses</h2>
            @if (editing() === null) {<button pcButton variant="secondary" size="sm" (click)="editing.set('new')">Add address</button>}
          </div>
          @if (editing() !== null) {
            @for (e of [editing()]; track editKey()) {
              <pc-address-form [initial]="e === 'new' ? undefined : $any(e)" [cancellable]="true" (saved)="onSaved()" (cancelled)="editing.set(null)" />
            }
          } @else if (addresses()!.length === 0) {
            <p class="text-ink-soft">No saved addresses yet.</p>
          } @else {
            <ul class="divide-y divide-line">
              @for (a of addresses(); track a.id) {
                <li class="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div class="min-w-0">
                    <p class="flex flex-wrap items-center gap-1.5 font-semibold">
                      {{ a.full_name }} <pc-pill>{{ a.label?.trim() || KIND[a.kind] }}</pc-pill>
                      @if (a.is_default) {<pc-pill tone="blue">Default</pc-pill>}
                      @if (a.lat != null) {<pc-pill tone="green"><svg [pcIcon]="MapPin" class="mr-0.5 h-3 w-3" />Pinned</pc-pill>}
                    </p>
                    <p class="text-ink-soft" translate="no">{{ line(a) }}</p>
                    <p class="text-sm text-ink-faint">{{ a.phone }}</p>
                    @if (a.instructions) {<p class="mt-1 text-sm text-ink-soft"><span class="font-semibold text-ink">Instructions:</span> {{ a.instructions }}</p>}
                  </div>
                  <div class="flex gap-2">
                    <button pcButton variant="ghost" size="sm" (click)="editing.set(a)">Edit</button>
                    <button pcButton variant="ghost" size="sm" (click)="remove(a)">Remove</button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
        <pc-saved-cards />
      </div>
    }
  `,
})
export class ShopAccountPage {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  protected readonly name = signal("");
  protected readonly email = signal("");
  protected readonly addresses = signal<Address[] | null>(null);
  protected readonly editing = signal<Address | "new" | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly KIND = KIND;
  protected readonly MapPin = MapPin;

  constructor() {
    // fill the form from the signed-in account once (and again only if another account signs in)
    let seeded: string | null = null;
    effect(() => {
      const user = this.session.user();
      if (user && seeded !== user.id) {
        seeded = user.id;
        untracked(() => {
          this.name.set(user.name);
          this.email.set(user.email ?? "");
        });
      }
    });
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && !user) void this.router.navigateByUrl("/login?next=/account", { replaceUrl: true });
      if (user) untracked(() => this.load());
    });
  }

  protected editKey(): string {
    const e = this.editing();
    return e === null ? "" : e === "new" ? "new" : e.id;
  }

  protected line(a: Address): string {
    return `${[a.line1, a.line2, a.landmark, a.city].filter(Boolean).join(", ")}, ${a.state} ${a.pincode}`;
  }

  private load(): void {
    api<Address[]>("/api/addresses").then((a) => this.addresses.set(a)).catch(quietly);
  }

  protected async saveProfile(e: Event): Promise<void> {
    e.preventDefault();
    this.saving.set(true);
    this.error.set(null);
    try {
      const email = this.email();
      await api("/api/auth/me", { method: "PATCH", body: { name: this.name(), ...(email ? { email } : {}) } });
      await this.session.reloadUser();
      this.toast.show("Profile saved");
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      this.saving.set(false);
    }
  }

  protected signOut(): void {
    void this.session.signOut().then(() => this.router.navigateByUrl("/"));
  }

  protected onSaved(): void {
    this.editing.set(null);
    this.load();
    this.toast.show("Address saved");
  }

  protected async remove(a: Address): Promise<void> {
    await api(`/api/addresses/${a.id}`, { method: "DELETE" });
    this.toast.show("Address removed");
    this.load();
  }
}
