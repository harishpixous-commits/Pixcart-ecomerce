/* Each area's "not found" page (app/(shop)/not-found.tsx, app/admin/not-found.tsx, ...), used as the `**` route. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { NotFoundView } from "./error-pages";

@Component({
  selector: "pc-shop-not-found",
  imports: [NotFoundView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-not-found-view area="shop" />`,
})
export class ShopNotFound {}

@Component({
  selector: "pc-admin-not-found",
  imports: [NotFoundView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-not-found-view area="admin" />`,
})
export class AdminNotFound {}

@Component({
  selector: "pc-seller-not-found",
  imports: [NotFoundView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-not-found-view area="seller" />`,
})
export class SellerNotFound {}

@Component({
  selector: "pc-delivery-not-found",
  imports: [NotFoundView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-not-found-view area="delivery" />`,
})
export class DeliveryNotFound {}
