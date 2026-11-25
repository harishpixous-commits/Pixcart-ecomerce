/* Admin → Coupons (platform-funded). Port of frontend/src/app/admin/coupons/page.tsx. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { CouponManager } from "../../shared/portal/coupons";

@Component({
  selector: "pc-admin-coupons-page",
  imports: [CouponManager],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `<pc-coupon-manager base="/api/admin/coupons" [admin]="true" />`,
})
export class AdminCouponsPage {}
