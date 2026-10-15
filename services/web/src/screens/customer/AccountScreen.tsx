/**
 * SCR-019 — Account & profile (FR-CUS-004).
 *
 * Reads the signed-in user from the auth session (already verified against
 * `/account` on load) and re-reads the server's profile projection, so a
 * change made elsewhere shows up here rather than a stale cached copy.
 *
 * Profile editing is intentionally absent: the BFF exposes no `PATCH /account`
 * route in this release, so the name/email/mobile fields are shown read-only
 * with a note pointing at identity-svc as the owner of those attributes.
 * A form that always 404s would be worse than no form.
 *
 * The page is a hub: profile, saved addresses, notifications, wallet and
 * loyalty each link to their own surface rather than inlining every control
 * here. Sign-out is the one destructive action and it goes through
 * `AuthProvider.logout`, which revokes the refresh token server-side.
 */
import { Link } from 'react-router-dom';
import type { SessionUser } from '@contracts/dto';
import { Badge, Button, LinkButton } from '../../design';
import { api } from '../../lib/api';
import { number } from '../../lib/format';
import { useAuth } from '../../app/AuthContext';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

interface LoyaltyView {
  points: number;
  tier: 'SILVER' | 'GOLD' | 'PLATINUM';
}

function AccountInner() {
  const { user, logout } = useAuth();

  const profile = useAsync<SessionUser>(
    async (signal) => (await api.account(signal)) as SessionUser,
    [],
  );
  const loyalty = useAsync<LoyaltyView | null>(
    async (signal) => (await api.loyalty(signal)) as LoyaltyView,
    [],
  );

  const shown = profile.data ?? user;

  return (
    <div>
      <PageHeader
        title="Account"
        description="Your profile, addresses, notifications and wallet in one place."
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </Button>
        }
      />

      <div className="pxcu-stack">
        <section className="px-panel" aria-labelledby="acct-profile">
          <div className="px-panel__head">
            <h2 id="acct-profile">Profile</h2>
          </div>
          {profile.status === 'loading' && !shown && <ScreenLoading label="Loading your profile" />}
          {profile.status === 'error' && !shown && (
            <ScreenError error={profile.error} onRetry={profile.reload} />
          )}
          {shown && (
            <>
              <dl className="px-dl">
                <dt>Name</dt>
                <dd>{shown.displayName}</dd>
                <dt>Email</dt>
                <dd>{shown.email ?? '—'}</dd>
                <dt>Mobile</dt>
                <dd>{shown.mobile ?? '—'}</dd>
                <dt>Role</dt>
                <dd>
                  <Badge tone="info">{shown.role}</Badge>
                </dd>
                <dt>Language</dt>
                <dd>{shown.locale}</dd>
              </dl>
              <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-4)' }}>
                Your name, email and mobile are held by the identity service, which owns
                credentials and profile attributes. Editing them is not offered here because this
                release's API has no profile-update route — anything else would be a form that
                cannot save.
              </p>
            </>
          )}
        </section>

        <section className="px-panel" aria-labelledby="acct-links">
          <div className="px-panel__head">
            <h2 id="acct-links">Manage</h2>
          </div>
          <ul className="pxcu-cats">
            <li>
              <Link className="pxcu-cat" to="/account/addresses">
                Addresses
                <span className="pxcu-cat__count">delivery book</span>
              </Link>
            </li>
            <li>
              <Link className="pxcu-cat" to="/account/notifications">
                Notifications
                <span className="pxcu-cat__count">inbox</span>
              </Link>
            </li>
            <li>
              <Link className="pxcu-cat" to="/account/wallet">
                Wallet &amp; rewards
                {loyalty.data && (
                  <span className="pxcu-cat__count">
                    {number(loyalty.data.points)} pts · {loyalty.data.tier}
                  </span>
                )}
              </Link>
            </li>
            <li>
              <Link className="pxcu-cat" to="/orders">
                Orders
              </Link>
            </li>
            <li>
              <Link className="pxcu-cat" to="/returns">
                Returns
              </Link>
            </li>
            <li>
              <Link className="pxcu-cat" to="/wishlist">
                Wishlist
              </Link>
            </li>
          </ul>
        </section>

        <div className="pxcu-row">
          <LinkButton to="/account/addresses" variant="secondary">
            Manage addresses
          </LinkButton>
          <LinkButton to="/account/wallet" variant="secondary">
            Open wallet
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

export function AccountScreen() {
  return (
    <RequireCustomer>
      <AccountInner />
    </RequireCustomer>
  );
}
