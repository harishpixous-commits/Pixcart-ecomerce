import { ChangeDetectionStrategy, Component, afterNextRender, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { RegionalService } from "./core/regional";
import { NavTracker } from "./shared/chrome/back-button";
import { RouteProgress } from "./shared/chrome/route-progress";
import { ToastHost } from "./shared/ui/ui";

/** The root: the page loading bar, the routed page (in its area's frame) and the toasts. Mirrors app/layout.tsx. */
@Component({
  selector: "app-root",
  imports: [RouterOutlet, RouteProgress, ToastHost],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-route-progress /><router-outlet /><pc-toast-host />`,
})
export class App {
  constructor() {
    inject(NavTracker).start();
    const regional = inject(RegionalService);
    afterNextRender(() => regional.startTranslator());
  }
}
