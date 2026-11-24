/* Small helpers shared by the Fresh header, tab bar and floating cart pill. */

/** "1 item", "3 items". */
export function itemsLabel(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/** A count that fits a small badge: "7", "99+". */
export function badgeCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Whether a path is a cart or checkout page (the floating cart pill and the header cart stay out of the way there). */
export function isCartPath(pathname: string): boolean {
  return pathname.startsWith("/cart") || pathname.startsWith("/checkout");
}
