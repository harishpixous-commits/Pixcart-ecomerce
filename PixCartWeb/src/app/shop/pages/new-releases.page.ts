import { ChangeDetectionStrategy, Component } from "@angular/core";
import { TopList } from "./top-list";

@Component({
  selector: "pc-shop-new-releases-page",
  imports: [TopList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `<pc-top-list list="new" />`,
})
export class ShopNewReleasesPage {}
