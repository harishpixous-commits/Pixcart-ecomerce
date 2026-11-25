/*
 * The delivery options (cached for the visit) and the signed-in partner. Port of the first half of
 * components/delivery/app.tsx (useDeliveryOptions, usePartner); kept apart from the shell so the feed can use them.
 */

import { Injectable, signal } from "@angular/core";
import { ApiError, api } from "../../core/api";
import type { DeliveryOptions, Partner } from "../../core/delivery-types";

/* ---------------------------------------------------------------- options (cached for the visit) */

let optionsCache: Promise<DeliveryOptions> | null = null;

export function loadDeliveryOptions(): Promise<DeliveryOptions> {
  if (!optionsCache) optionsCache = api<DeliveryOptions>("/api/delivery/options").catch((e) => { optionsCache = null; throw e; });
  return optionsCache;
}

/** useDeliveryOptions(): call in a field initialiser; the signal fills in once loaded. */
export function deliveryOptions() {
  const o = signal<DeliveryOptions | null>(null);
  loadDeliveryOptions().then((x) => o.set(x)).catch(() => {});
  return o.asReadonly();
}

/* ---------------------------------------------------------------- the signed-in partner */

export type PartnerStatus = "loading" | "none" | "ready" | "error";

/** usePartner(): the partner of the signed-in account. DeliveryLayout calls start() whenever the account changes. */
@Injectable({ providedIn: "root" })
export class PartnerService {
  readonly partner = signal<Partner | null>(null);
  readonly status = signal<PartnerStatus>("loading");
  private forUser: string | null = null;

  /** Loads the partner for this account (again only when the account changed). */
  start(userId: string): void {
    if (this.forUser === userId) return;
    this.forUser = userId;
    this.partner.set(null);
    this.status.set("loading");
    void this.reload();
  }

  reload(): Promise<void> {
    return api<Partner>("/api/delivery/me")
      .then((p) => { this.partner.set(p); this.status.set("ready"); })
      .catch((e) => { this.partner.set(null); this.status.set(e instanceof ApiError && e.code === "not_registered" ? "none" : "error"); });
  }

  set(p: Partner): void {
    this.partner.set(p);
    this.status.set("ready");
  }
}
