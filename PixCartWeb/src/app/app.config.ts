import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from "@angular/core";
import { TitleStrategy, provideRouter, withComponentInputBinding, withInMemoryScrolling } from "@angular/router";
import { providePrimeNG } from "primeng/config";
import { routes } from "./app.routes";
import { applyBrand } from "./core/brand";
import { PIXCART_PT } from "./core/primeng-pt";
import { RegionalService } from "./core/regional";
import { SessionService } from "./core/session";
import { SiteService } from "./core/site";
import { PageTitleStrategy } from "./core/title-strategy";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: "enabled", anchorScrolling: "enabled" })),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
    providePrimeNG({ unstyled: true, pt: PIXCART_PT, ripple: false }),
    // Like the reference root layout: brand, colours and the visitor's language and currency before the first render.
    provideAppInitializer(async () => {
      const site = inject(SiteService);
      const regional = inject(RegionalService);
      const session = inject(SessionService);
      const [s] = await Promise.all([site.load(), regional.load()]);
      applyBrand(s);
      session.start();
    }),
  ],
};
