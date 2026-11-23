/*
 * Back navigation that works everywhere, including the installed app on iPhone (which has no browser back button):
 * goes back when the visitor came from inside the site, otherwise to the page's logical parent (fallback).
 * Port of components/back-button.tsx: NavTracker (a service started by the root), goBack(), <pc-back-link>, <pc-shop-back-bar>.
 */

import { Location } from "@angular/common";
import { ChangeDetectionStrategy, Component, Injectable, computed, inject, input } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import { ChevronLeft } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";

// How many pages deep the visitor is inside this site in this tab (sessionStorage, so it survives full page loads).
const DEPTH = "pc_nav_depth";
let poppedBack = false;
if (typeof window !== "undefined") window.addEventListener("popstate", () => { poppedBack = true; });
function readDepth(): number {
  try { return Number(sessionStorage.getItem(DEPTH) || 0); } catch { return 0; }
}
function writeDepth(n: number) {
  try { sessionStorage.setItem(DEPTH, String(Math.max(0, n))); } catch { /* storage blocked */ }
}

/** Started once by the root component: counts page changes inside the site (back steps count down). */
@Injectable({ providedIn: "root" })
export class NavTracker {
  private readonly router = inject(Router);
  private started = false;
  private last = "";
  start(): void {
    if (this.started) return;
    this.started = true;
    this.router.events.subscribe((e) => {
      if (!(e instanceof NavigationEnd)) return;
      const path = new URL(e.urlAfterRedirects, "http://x").pathname;
      if (path === this.last) return;
      this.last = path;
      writeDepth(poppedBack ? readDepth() - 1 : readDepth() + 1);
      poppedBack = false;
    });
  }
}

function cameFromHere(): boolean {
  if (readDepth() > 1) return true;
  try {
    return window.history.length > 1 && !!document.referrer && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** useGoBack(fallback): call inside an injection context; returns the function to call on click. */
export function goBackFn(): (fallback: string) => void {
  const router = inject(Router);
  const location = inject(Location);
  return (fallback: string) => {
    if (cameFromHere()) location.back();
    else void router.navigateByUrl(fallback);
  };
}

@Component({
  selector: "pc-back-link",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="back(fallback())" data-testid="back-link" [class]="cls()">
      <svg [pcIcon]="ChevronLeft" class="h-4 w-4" /> {{ label() }}
    </button>
  `,
})
export class BackLink {
  readonly fallback = input.required<string>();
  readonly label = input("Back");
  /** extra classes (the reference's className) */
  readonly extra = input<string>("", { alias: "class" });
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly back = goBackFn();
  protected readonly cls = computed(() => cx("-ml-1 inline-flex items-center gap-0.5 rounded-md py-1 pr-2 text-sm font-semibold text-peacock hover:bg-peacock/5", this.extra()));
}

/** The parent page for a shop address: /orders/123 → /orders, /help/returns → /help, /support/new → /support. */
export function shopParent(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  if (parts[0] === "p" || parts[0] === "c" || parts[0] === "store" || parts[0] === "pages") return "/";
  return `/${parts[0]}`;
}

// Pages people reach from the menu: a back bar only on phones. Deeper pages get it on every screen.
const DESKTOP_TOO = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return (parts.length >= 2 && !["p", "c"].includes(parts[0])) || ["/compare", "/checkout", "/app"].includes(path);
};

@Component({
  selector: "pc-shop-back-bar",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (path() !== "/") {
      <div [class]="cls()" data-testid="shop-back-bar">
        <button type="button" (click)="back(parent())" aria-label="Go back"
          class="-ml-1 inline-flex items-center gap-0.5 rounded-md py-1 pr-2 text-sm font-semibold text-peacock hover:bg-peacock/5">
          <svg [pcIcon]="ChevronLeft" class="h-5 w-5" /> Back
        </button>
      </div>
    }
  `,
})
export class ShopBackBar {
  protected readonly path = inject(RouteState).pathname;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly back = goBackFn();
  protected readonly parent = computed(() => shopParent(this.path()));
  protected readonly cls = computed(() => cx("mx-auto w-full max-w-shop px-3 pt-2 sm:px-4", !DESKTOP_TOO(this.path()) && "sm:hidden"));
}
