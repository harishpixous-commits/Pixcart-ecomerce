"use client";

import clsx from "clsx";
import { Bell, ChevronDown, Heart, Home, LayoutGrid, MapPin, Package, ShoppingCart, User as UserIcon, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isPincode, setPincode, usePincode } from "@/lib/pincode";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { fillTokens, splitBrand } from "@/lib/tokens";
import { NavBar, ReturnsOrders, SearchBox } from "@/components/shop-nav";
import type { Address, CategoryNode } from "@/lib/types";
import { ContactList, fillCopyright, SocialLinks } from "@/components/social";

let categoryCache: CategoryNode[] | null = null;

export function useCategories() {
  const [cats, setCats] = useState<CategoryNode[]>(categoryCache ?? []);
  useEffect(() => {
    if (categoryCache) return;
    api<CategoryNode[]>("/api/catalog/categories")
      .then((c) => {
        categoryCache = c;
        setCats(c);
      })
      .catch(() => {});
  }, []);
  return cats;
}

export function Logo({ light = true }: { light?: boolean }) {
  const site = useSite();
  if (site.logo_url) {
    return (
      <Link href="/" className="flex items-center" aria-label={`${site.brand_name} home`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={site.logo_url} alt={site.brand_name} className="h-9 w-auto max-w-[160px] object-contain" />
      </Link>
    );
  }
  const name = site.brand_name;
  const [first, second] = splitBrand(name);
  return (
    <Link href="/" className={clsx("flex items-baseline font-display text-2xl font-bold tracking-tight", light ? "text-white" : "text-peacock")} aria-label={`${name} home`}>
      {first}
      {second && <span className="text-marigold">{second}</span>}
    </Link>
  );
}

export function AnnouncementBar() {
  const site = useSite();
  const a = site.announcement;
  if (!a.enabled || !a.text) return null;
  const tone = a.tone === "primary" ? "bg-peacock-dark text-white" : a.tone === "dark" ? "bg-ink text-white" : "bg-marigold text-ink";
  const body = <span className="mx-auto block max-w-shop truncate px-4 py-1.5 text-center text-sm font-medium">{fillTokens(a.text, site)}</span>;
  return a.link ? <Link href={a.link} className={clsx("block hover:opacity-90", tone)}>{body}</Link> : <div className={tone}>{body}</div>;
}

export function NotificationBell({ dark }: { dark?: boolean }) {
  const { user } = useSession();
  const [count, setCount] = useState(0);
  const pathname = usePathname();
  useEffect(() => {
    if (!user) return;
    api<{ unread: number }>("/api/notifications").then((r) => setCount(r.unread)).catch(() => {});
  }, [user, pathname]);
  if (!user) return null;
  return (
    <Link href="/notifications" className={clsx("relative flex h-10 w-10 items-center justify-center rounded-lg", dark ? "text-ink-soft hover:bg-mist" : "text-white hover:bg-white/10")} aria-label={`Notifications, ${count} unread`}>
      <Bell className="h-5 w-5" />
      {count > 0 && <span className="absolute right-1 top-1 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white">{count > 9 ? "9+" : count}</span>}
    </Link>
  );
}

function AccountMenu() {
  const site = useSite();
  const { user, ready, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  if (pathname !== path) {
    // a new page: close the menu
    setPath(pathname);
    setOpen(false);
  }
  if (!ready) return <div className="h-10 w-24" />;
  if (!user)
    return (
      <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="flex h-10 items-center gap-2 rounded-lg px-2 text-white hover:bg-white/10 sm:px-3" data-testid="account-signin">
        <UserIcon className="h-5 w-5 sm:hidden" />
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="text-xs text-white/80">Hello, sign in</span>
          <span className="text-sm font-semibold">Account &amp; Lists</span>
        </span>
      </Link>
    );
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-10 items-center gap-1.5 rounded-lg px-2 text-left text-white hover:bg-white/10 sm:px-3" aria-expanded={open}>
        <UserIcon className="h-5 w-5 sm:hidden" />
        <span className="hidden flex-col leading-tight sm:flex">
          <span className="max-w-[130px] truncate text-xs text-white/80">Hello, {user.name?.split(" ")[0] || "there"}</span>
          <span className="text-sm font-semibold">Account &amp; Lists</span>
        </span>
        <ChevronDown className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-56 overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line">
          <Link href="/orders" className="block px-4 py-2 hover:bg-mist">Your orders</Link>
          <Link href="/wishlist" className="block px-4 py-2 hover:bg-mist">Wishlist</Link>
          <Link href="/support" className="block px-4 py-2 hover:bg-mist">Help and support</Link>
          <Link href="/contact" className="block px-4 py-2 hover:bg-mist">Contact us</Link>
          <Link href="/account" className="block px-4 py-2 hover:bg-mist">Profile and addresses</Link>
          {user.seller ? (
            <Link href="/seller" className="block px-4 py-2 hover:bg-mist">Seller dashboard</Link>
          ) : (
            <Link href="/sell" className="block px-4 py-2 hover:bg-mist">Sell on {site.brand_name}</Link>
          )}
          {user.is_admin && <Link href="/admin" className="block px-4 py-2 hover:bg-mist">Admin panel</Link>}
          <button onClick={() => signOut()} className="block w-full border-t border-line px-4 py-2 text-left hover:bg-mist">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** "Deliver to 641001": one PIN code for the whole visit; product pages show delivery dates for it. */
function DeliverTo() {
  const pin = usePincode();
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [addresses, setAddresses] = useState<Address[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!user) return;
    api<Address[]>("/api/addresses")
      .then((list) => {
        setAddresses(list);
        const def = list.find((a) => a.is_default) ?? list[0];
        if (def && !localStorage.getItem("pc_pin")) setPincode(def.pincode);
      })
      .catch(() => {});
  }, [user]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!isPincode(value)) return setError("Enter a valid 6-digit PIN code");
    setPincode(value);
    setOpen(false);
  }
  return (
    <div className="relative shrink-0" ref={box}>
      <button type="button" onClick={() => { setValue(pin); setError(""); setOpen((o) => !o); }} aria-expanded={open}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[14px] text-ink-soft hover:bg-peacock-light hover:text-peacock" data-testid="deliver-to">
        <MapPin className="h-4 w-4 text-peacock" />
        {pin ? <span>Deliver to <span className="font-semibold text-ink">{pin}</span></span> : <span className="font-semibold">Set delivery PIN</span>}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-40 w-[300px] rounded-xl bg-white p-4 text-ink shadow-xl ring-1 ring-line">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-semibold">Choose your location</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 hover:bg-mist"><X className="h-4 w-4" /></button>
          </div>
          <p className="mb-3 text-sm text-ink-soft">Delivery dates, charges and cash on delivery depend on where you are.</p>
          {addresses.length > 0 && (
            <ul className="mb-3 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
              {addresses.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => { setPincode(a.pincode); setOpen(false); }}
                    className={clsx("w-full rounded-lg border px-3 py-2 text-left text-sm", a.pincode === pin ? "border-peacock bg-peacock-light" : "border-line hover:border-peacock")}>
                    <span className="font-semibold">{a.full_name}</span> · {a.city} {a.pincode}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={apply} className="flex gap-2">
            <label htmlFor="hdr-pin" className="sr-only">PIN code</label>
            <input id="hdr-pin" inputMode="numeric" maxLength={6} value={value} autoFocus placeholder="Enter PIN code"
              onChange={(e) => { setValue(e.target.value.replace(/\D/g, "")); setError(""); }}
              className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 focus:border-peacock focus:outline-none" />
            <button type="submit" className="h-10 rounded-lg bg-peacock px-4 font-semibold text-white hover:bg-peacock-dark">Apply</button>
          </form>
          {error && <p className="mt-1 text-sm text-vermilion">{error}</p>}
          {!user && <p className="mt-3 text-xs text-ink-faint"><Link href="/login" className="font-semibold text-peacock">Sign in</Link> to use your saved addresses.</p>}
        </div>
      )}
    </div>
  );
}

function CartLink() {
  const { cartCount } = useSession();
  return (
    <Link href="/cart" className="relative flex h-10 items-center gap-2 rounded-lg px-3 font-semibold text-white hover:bg-white/10" aria-label={`Cart, ${cartCount} items`}>
      <ShoppingCart className="h-5 w-5" />
      <span className="hidden sm:inline">Cart</span>
      {cartCount > 0 && (
        <span className="absolute -top-0.5 left-6 min-w-[20px] rounded-full bg-marigold px-1 text-center text-xs font-bold leading-5 text-ink">{cartCount > 99 ? "99+" : cartCount}</span>
      )}
    </Link>
  );
}

export function ShopHeader() {
  const cats = useCategories();
  const site = useSite();
  return (
    <header className="sticky top-0 z-30">
      <AnnouncementBar />
      <div className="bg-peacock">
        <div className="mx-auto flex max-w-shop flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-4">
          <Logo />
          <div className="order-last w-full sm:order-none sm:flex-1">
            <Suspense>
              <SearchBox categories={cats} />
            </Suspense>
          </div>
          <nav className="ml-auto flex items-center gap-1 sm:ml-0">
            {site.header_links.map((l) => (
              <Link key={l.href} href={l.href} className="hidden h-10 items-center rounded-lg px-3 font-semibold text-white hover:bg-white/10 lg:flex">
                {l.label}
              </Link>
            ))}
            {site.features.wishlist && (
              <Link href="/wishlist" className="hidden h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:flex" aria-label="Wishlist">
                <Heart className="h-5 w-5" />
              </Link>
            )}
            <NotificationBell />
            <AccountMenu />
            <ReturnsOrders />
            <CartLink />
          </nav>
        </div>
      </div>
      <div className="relative bg-white shadow-sm">
        <div className="awning absolute inset-x-0 top-0" aria-hidden />
        <NavBar categories={cats} deliverTo={site.pdp?.header_pincode !== false ? <DeliverTo /> : null} />
      </div>
    </header>
  );
}

export function MobileTabBar() {
  const pathname = usePathname();
  const { cartCount } = useSession();
  const tabs = [
    { href: "/", label: "Home", icon: Home },
    { href: "/categories", label: "Categories", icon: LayoutGrid },
    { href: "/orders", label: "Orders", icon: Package },
    { href: "/cart", label: "Cart", icon: ShoppingCart },
    { href: "/account", label: "Account", icon: UserIcon },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Main">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={clsx("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", active ? "text-peacock" : "text-ink-faint")}>
            <Icon className="h-5 w-5" />
            {label}
            {href === "/cart" && cartCount > 0 && <span className="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-vermilion" />}
          </Link>
        );
      })}
    </nav>
  );
}

export function ShopFooter() {
  const site = useSite();
  const b = site.business;
  const f = site.footer;
  const legal = b.legal_name || site.brand_name;
  const contactOn = f.show_contact && site.contact.enabled && site.contact.items.some((i) => i.enabled);
  const socialOn = f.show_social && site.social.enabled && site.social.links.some((l) => l.enabled && l.url);
  const g = b.grievance;
  return (
    <footer className="mt-12 bg-peacock-dark pb-20 text-white/80 sm:pb-0">
      <div className="mx-auto grid max-w-shop gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-5">
        <div className="flex flex-col gap-3 lg:col-span-1">
          <Logo />
          {site.tagline && <p className="text-sm">{site.tagline}</p>}
          {socialOn && (
            <div>
              {site.social.title && <p className="mb-2 text-sm font-semibold text-white">{site.social.title}</p>}
              <SocialLinks links={site.social.links} />
            </div>
          )}
        </div>
        {site.footer_columns.map((col) => (
          <nav key={col.title} className="flex flex-col gap-1.5 text-sm" aria-label={col.title}>
            <p className="font-semibold text-white">{col.title}</p>
            {col.links.map((l) =>
              l.href.startsWith("https://") ? (
                <a key={l.href + l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="hover:text-white">{l.label}</a>
              ) : (
                <Link key={l.href + l.label} href={l.href} className="hover:text-white">{l.label}</Link>
              ),
            )}
          </nav>
        ))}
        {(contactOn || (f.show_grievance && g.name)) && (
          <div className="flex flex-col gap-4 text-sm">
            {contactOn && (
              <div>
                <p className="mb-2 font-semibold text-white">{site.contact.title || "Contact us"}</p>
                <ContactList items={site.contact.items} />
              </div>
            )}
            {f.show_grievance && g.name && (
              <div>
                <p className="font-semibold text-white">Grievance officer</p>
                <p>{g.name}{g.designation ? `, ${g.designation}` : ""}</p>
                {g.email && <a href={`mailto:${g.email}`} className="block hover:text-white">{g.email}</a>}
                {g.phone && <p>{g.phone}</p>}
                <Link href="/help/grievance" className="mt-1 block text-white underline-offset-2 hover:underline">How to raise a complaint</Link>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-shop flex-col gap-1 px-4 py-4 text-xs text-white/60">
          {f.copyright && <p>{fillCopyright(f.copyright, { legal_name: legal, brand: site.brand_name })}</p>}
          {f.show_business && (b.registered_address || (f.show_gstin && b.gstin) || b.cin) && (
            <p>
              {[b.legal_name, b.registered_address ? `Registered office: ${b.registered_address}` : "", f.show_gstin && b.gstin ? `GSTIN ${b.gstin}` : "", b.cin ? `CIN ${b.cin}` : ""].filter(Boolean).join(". ")}
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
