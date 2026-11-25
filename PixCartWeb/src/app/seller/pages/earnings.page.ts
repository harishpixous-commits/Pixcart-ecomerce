/*
 * Earnings moved into Payouts (balances, payouts and the full statement). Port of frontend/src/app/seller/earnings/page.tsx,
 * which only redirects to /seller/payouts.
 */

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { Router } from "@angular/router";

@Component({
  selector: "pc-seller-earnings-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: ``,
})
export class SellerEarningsPage {
  constructor() {
    void inject(Router).navigateByUrl("/seller/payouts", { replaceUrl: true });
  }
}
