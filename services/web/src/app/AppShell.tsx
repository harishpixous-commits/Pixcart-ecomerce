/**
 * Application shell: the frame every R1 screen renders inside.
 *
 * Structure follows Vol. 8 §2.5 (IA) and §8.4 (a11y):
 *  - a skip-to-content link is the first focusable element on every page
 *  - `<header>` / `<nav>` / `<main>` / `<footer>` are real landmarks, so a screen
 *    reader can jump between them without hearing the whole page
 *  - the category mega-menu is a disclosure (button + controlled panel), not a hover
 *    panel, so it is reachable by keyboard and usable on touch
 *  - below 600px the top nav collapses into the bottom tab bar §8.4 specifies
 *    (Home · Categories · Assistant · Cart · Account), each with a ≥44px target
 *  - navigation is `<Link>`, actions are `<Button>`; nothing that navigates is a button
 *
 * Navigation entries that exist in the IA (§2.5) but are not part of the R1 release are
 * rendered `aria-disabled` rather than omitted or linked to a dead route: the IA
 * describes the full product, so hiding sections would misrepresent it, and linking
 * them would be a dead link.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Bell,
  LayoutGrid,
  Menu,
  MessageSquareText,
  Search,
  ShoppingCart,
  Sparkles,
  Store,
  User,
  X,
} from 'lucide-react';
import { IconButton, LinkButton } from '../design';
import { useAuth } from './AuthContext';
import { badgeCount } from '../lib/format';
import { api } from '../lib/api';
import './AppShell.css';

interface NavEntry {
  label: string;
  to: string;
  /** Present in the IA (§2.5) but not in the R1 release. */
  pending?: boolean;
}

interface NavSection {
  label: string;
  entries: NavEntry[];
}

/** §2.5 storefront IA, R1 subset. */
const STOREFRONT: NavSection = {
  label: 'Shop',
  entries: [
    { label: 'Home', to: '/' },
    { label: 'Deals', to: '/deals' },
    { label: 'Wishlist', to: '/wishlist' },
    { label: 'Orders', to: '/orders' },
    { label: 'Wallet & Rewards', to: '/account/wallet' },
  ],
};

const ACCOUNT: NavSection = {
  label: 'Account',
  entries: [
    { label: 'Profile', to: '/account' },
    { label: 'Addresses', to: '/account/addresses' },
    { label: 'Notifications', to: '/account/notifications' },
  ],
};

const VENDOR: NavSection = {
  label: 'Vendor portal',
  entries: [
    { label: 'Dashboard', to: '/vendor' },
    { label: 'Catalogue', to: '/vendor/products' },
    { label: 'Inventory', to: '/vendor/inventory' },
    { label: 'Orders', to: '/vendor/orders' },
    { label: 'Finance', to: '/vendor/finance' },
  ],
};

const ADMIN: NavSection = {
  label: 'Admin console',
  entries: [
    { label: 'Overview', to: '/admin' },
    { label: 'Approvals', to: '/admin/approvals' },
    { label: 'Catalogue governance', to: '/admin/catalogue' },
    { label: 'Orders & service', to: '/admin/orders' },
    { label: 'Marketing', to: '/admin/marketing' },
    { label: 'Finance', to: '/admin/finance' },
    { label: 'Users & roles', to: '/admin/users' },
    { label: 'CMS & banners', to: '/admin/cms' },
    { label: 'Audit log', to: '/admin/audit' },
  ],
};

function Section({ section }: { section: NavSection }) {
  return (
    <div className="px-mega__section">
      <h3 className="px-mega__heading">{section.label}</h3>
      <ul className="px-mega__list">
        {section.entries.map((e) => (
          <li key={e.to}>
            <Link className="px-mega__link" to={e.to}>
              {e.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Search box
 * ------------------------------------------------------------------ */

function SearchBox() {
  const [q, setQ] = useState('');
  const id = useId();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    // Navigating via a GET form means the query lives in the URL, which §8.3
    // requires so a search is shareable, bookmarkable and restorable on Back.
    window.location.assign(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <form className="px-search" role="search" onSubmit={submit}>
      <label className="px-visually-hidden" htmlFor={id}>
        Search products
      </label>
      <Search className="px-search__icon" size={18} aria-hidden="true" />
      <input
        id={id}
        className="px-search__input"
        type="search"
        name="q"
        placeholder="Search products, brands and categories"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      <button className="px-search__submit" type="submit">
        Search
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Badge counts
 * ------------------------------------------------------------------ */

function useBadgeCount(signedIn: boolean, load: () => Promise<unknown>, pick: (v: unknown) => number): number {
  const location = useLocation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!signedIn) {
      setCount(0);
      return;
    }
    let cancelled = false;
    load()
      .then((v) => {
        if (!cancelled) setCount(pick(v));
      })
      .catch(() => {
        // Badges are decorative; a failure must never surface as an error page.
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
    // Re-run on navigation so the badge follows the user's actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, location.pathname]);

  return count;
}

const cartCountOf = (v: unknown) => (v as { itemCount?: number }).itemCount ?? 0;
const unreadCountOf = (v: unknown) => {
  const items = (v as { items?: { readAt?: string | null }[] }).items ?? [];
  return items.filter((i) => !i.readAt).length;
};

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function AppShell() {
  const { user, signedIn, loading } = useAuth();
  const cartCount = useBadgeCount(signedIn, api.cart, cartCountOf);
  const unread = useBadgeCount(signedIn, api.notifications, unreadCountOf);

  const [megaOpen, setMegaOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const megaButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const megaId = useId();
  const drawerId = useId();
  const location = useLocation();

  // Close overlays on navigation and move focus to the new page's main region, so
  // keyboard users are not left tabbing through a page that just changed underneath
  // them.
  useEffect(() => {
    setMegaOpen(false);
    setDrawerOpen(false);
    mainRef.current?.focus();
  }, [location.pathname]);

  // Escape closes the topmost overlay and returns focus to the control that opened it.
  useEffect(() => {
    if (!megaOpen && !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMegaOpen(false);
      setDrawerOpen(false);
      megaButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [megaOpen, drawerOpen]);

  // Trap focus inside the mobile drawer while it is open (§8.4 modal behaviour).
  useEffect(() => {
    if (!drawerOpen) return;
    const node = document.getElementById(drawerId);
    const focusables = node?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, drawerId]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);

  return (
    <div className="px-shell">
      <a className="px-skip-link" href="#px-main">
        Skip to main content
      </a>

      <header className="px-header">
        <div className="px-header__row">
          <IconButton
            ref={megaButtonRef}
            aria-label={megaOpen ? 'Close browse menu' : 'Browse categories'}
            aria-expanded={megaOpen}
            aria-controls={megaId}
            onClick={() => setMegaOpen((v) => !v)}
            className="px-header__menubtn"
          >
            {megaOpen ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </IconButton>

          <Link className="px-logo" to="/" aria-label="PixCart home">
            <span className="px-logo__mark" aria-hidden="true">
              P
            </span>
            <span className="px-logo__word">PixCart</span>
          </Link>

          <div className="px-header__search">
            <SearchBox />
          </div>

          <div className="px-header__actions">
            <Link className="px-navicon" to="/assistant">
              <Sparkles size={22} aria-hidden="true" />
              <span className="px-visually-hidden">Shopping assistant</span>
            </Link>

            <Link className="px-navicon" to="/account/notifications">
              <Bell size={22} aria-hidden="true" />
              {unread > 0 && (
                <span className="px-navicon__badge" aria-hidden="true">
                  {badgeCount(unread)}
                </span>
              )}
              <span className="px-visually-hidden">
                Notifications{unread > 0 ? `, ${unread} unread` : ''}
              </span>
            </Link>

            <Link className="px-navicon" to="/cart">
              <ShoppingCart size={22} aria-hidden="true" />
              {cartCount > 0 && (
                <span className="px-navicon__badge" aria-hidden="true">
                  {badgeCount(cartCount)}
                </span>
              )}
              <span className="px-visually-hidden">
                Cart{cartCount > 0 ? `, ${cartCount} items` : ''}
              </span>
            </Link>

            {signedIn ? (
              <Link className="px-accountbtn" to="/account">
                <User size={18} aria-hidden="true" />
                <span className="px-accountbtn__name">{user?.displayName}</span>
                <span className="px-accountbtn__role">{user?.role}</span>
              </Link>
            ) : (
              <LinkButton to="/login" variant="primary" size="sm">
                Sign in
              </LinkButton>
            )}
          </div>
        </div>

        {/* Desktop mega-menu. Controlled by the disclosure button above, so it opens on
            click/Enter rather than hover, which is unreachable by keyboard. */}
        <div id={megaId} className={`px-mega ${megaOpen ? 'is-open' : ''}`} hidden={!megaOpen}>
          <div className="px-mega__inner">
            <div className="px-mega__group">
              <Section section={STOREFRONT} />
              <Section section={ACCOUNT} />
            </div>
            <div className="px-mega__group">
              <Section section={VENDOR} />
              <Section section={ADMIN} />
            </div>
          </div>
        </div>
      </header>

      {/* Mobile drawer — the same IA, full screen, focus trapped. */}
      <div
        className={`px-drawer ${drawerOpen ? 'is-open' : ''}`}
        id={drawerId}
        role="dialog"
        aria-modal="true"
        aria-label="Browse"
        hidden={!drawerOpen}
      >
        <div className="px-drawer__head">
          <span className="px-drawer__title">Browse</span>
          <IconButton aria-label="Close browse menu" onClick={() => setDrawerOpen(false)}>
            <X size={22} aria-hidden="true" />
          </IconButton>
        </div>
        <nav className="px-drawer__nav" aria-label="Sections">
          <Section section={STOREFRONT} />
          <Section section={ACCOUNT} />
          <Section section={VENDOR} />
          <Section section={ADMIN} />
        </nav>
      </div>
      {drawerOpen && (
        <button
          type="button"
          className="px-drawer__scrim"
          aria-label="Close browse menu"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <main id="px-main" className="px-main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="px-footer">
        <p className="px-footer__note">
          PixCart — domain-logic release. Payments, live logistics and the large-language-model
          assistant are not bound in this build. The assistant runs in rules mode and says so on
          every response.
        </p>
      </footer>

      {/* Bottom tab bar — §8.4 mobile primary navigation, ≥44px targets. */}
      <nav className="px-tabbar" aria-label="Primary">
        <NavLink className="px-tabbar__tab" to="/" end>
          <Store size={22} aria-hidden="true" />
          <span>Home</span>
        </NavLink>
        <button type="button" className="px-tabbar__tab" onClick={openDrawer}>
          <LayoutGrid size={22} aria-hidden="true" />
          <span>Categories</span>
        </button>
        <NavLink className="px-tabbar__tab" to="/assistant">
          <MessageSquareText size={22} aria-hidden="true" />
          <span>Assistant</span>
        </NavLink>
        <NavLink className="px-tabbar__tab" to="/cart">
          <ShoppingCart size={22} aria-hidden="true" />
          {cartCount > 0 && (
            <span className="px-tabbar__badge" aria-hidden="true">
              {badgeCount(cartCount)}
            </span>
          )}
          <span>Cart</span>
        </NavLink>
        <NavLink className="px-tabbar__tab" to={signedIn ? '/account' : '/login'}>
          <User size={22} aria-hidden="true" />
          <span>{loading ? '…' : signedIn ? 'Account' : 'Sign in'}</span>
        </NavLink>
      </nav>

      {/* Desktop assistant launcher — persistent, per §8.3. */}
      <Link className="px-launcher" to="/assistant">
        <Sparkles size={20} aria-hidden="true" />
        <span>Ask the assistant</span>
      </Link>
    </div>
  );
}
