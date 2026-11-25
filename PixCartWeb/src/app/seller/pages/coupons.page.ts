/* Seller coupons. Port of frontend/src/app/seller/coupons/page.tsx. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { CouponManager } from "../../shared/portal/coupons";

@Component({
  selector: "pc-seller-coupons-page",
  imports: [CouponManager],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `<pc-coupon-manager base="/api/seller/coupons" />`,
})
export class SellerCouponsPage {}
