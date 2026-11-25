/* /help/returns sends shoppers to the returns policy (edited in Admin → Storefront → Pages). Port of frontend/src/app/(shop)/help/returns/page.tsx. */

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { Router } from "@angular/router";

@Component({
  selector: "pc-shop-help-returns-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: ``,
})
export class ShopHelpReturnsPage {
  constructor() {
    void inject(Router).navigateByUrl("/pages/returns-policy", { replaceUrl: true });
  }
}
