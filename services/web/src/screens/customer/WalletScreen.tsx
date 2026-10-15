/**
 * SCR-022 — Wallet & loyalty (FR-CUS-019, FR-CUS-020).
 *
 * Two read-only ledgers: wallet balance (split cash/promo) with its movement
 * history, and loyalty points with tier and history. Both are append-only on
 * the server — a balance is the sum of entries, never a mutable field — so
 * this screen only ever reads and never offers a "spend" or "adjust" control
 * it could not honour.
 *
 * Cash and promo are shown as two balances rather than one total because they
 * behave differently at checkout (promo is typically the first to apply and
 * can carry its own expiry); collapsing them into a single number would hide
 * a distinction the payment rules make.
 */
import type { LoyaltyView, WalletView } from '@contracts/dto';
import { Badge } from '../../design';
import { api } from '../../lib/api';
import { money, dateTime, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

function WalletInner() {
  const wallet = useAsync<WalletView>(async (signal) => (await api.wallet(signal)) as WalletView, []);
  const loyalty = useAsync<LoyaltyView>(
    async (signal) => (await api.loyalty(signal)) as LoyaltyView,
    [],
  );

  if (wallet.status === 'loading' || loyalty.status === 'loading') {
    return <ScreenLoading label="Loading your wallet" />;
  }
  if (wallet.status === 'error') {
    return <ScreenError error={wallet.error} onRetry={wallet.reload} />;
  }

  const w = wallet.data;
  const l = loyalty.data;
  const totalPaise = (w?.cashPaise ?? 0) + (w?.promoPaise ?? 0);

  return (
    <div>
      <PageHeader
        title="Wallet & rewards"
        description="Your PixCart balance and loyalty points. Both are read from the server ledger."
      />

      <div className="px-kpis">
        <div className="px-kpi">
          <span className="px-kpi__label">Wallet balance</span>
          <span className="px-kpi__value px-num">{money(totalPaise)}</span>
          <span className="px-kpi__hint">
            Cash {money(w?.cashPaise ?? 0)} · Promo {money(w?.promoPaise ?? 0)}
          </span>
        </div>
        {l && (
          <>
            <div className="px-kpi">
              <span className="px-kpi__label">Loyalty points</span>
              <span className="px-kpi__value px-num">{number(l.points)}</span>
              <span className="px-kpi__hint">Redeemable at checkout</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Tier</span>
              <span className="px-kpi__value">
                <Badge tone="info">{l.tier}</Badge>
              </span>
              <span className="px-kpi__hint">Set by your recent order value</span>
            </div>
          </>
        )}
      </div>

      <section className="px-panel" aria-labelledby="wallet-ledger" style={{ marginTop: 'var(--px-space-6)' }}>
        <div className="px-panel__head">
          <h2 id="wallet-ledger">Wallet activity</h2>
        </div>
        {!w || w.entries.length === 0 ? (
          <ScreenEmpty
            title="No wallet activity yet"
            description="Refunds, cashback and promotional credit appear here as they are applied to your account."
          />
        ) : (
          <ul className="pxcu-lines">
            {w.entries.map((e) => (
              <li key={e.id} className="pxcu-line">
                <div>
                  <strong>{e.reason}</strong>
                  <span className="pxcu-line__meta">
                    <Badge tone={e.bucket === 'CASH' ? 'success' : 'info'} size="sm">
                      {e.bucket === 'CASH' ? 'Cash' : 'Promo'}
                    </Badge>{' '}
                    {dateTime(e.at)}
                  </span>
                </div>
                <div className="pxcu-line__side">
                  <span className="px-num" style={{ fontWeight: 'var(--px-fw-bold)' }}>
                    {money(e.amountPaise)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {l && (
        <section className="px-panel" aria-labelledby="wallet-loyalty" style={{ marginTop: 'var(--px-space-6)' }}>
          <div className="px-panel__head">
            <h2 id="wallet-loyalty">Loyalty activity</h2>
          </div>
          {l.entries.length === 0 ? (
            <ScreenEmpty
              title="No loyalty activity yet"
              description="Points are earned on delivered orders and shown here with the reason for each change."
            />
          ) : (
            <ul className="pxcu-lines">
              {l.entries.map((e) => (
                <li key={e.id} className="pxcu-line">
                  <div>
                    <strong>{e.reason}</strong>
                    <span className="pxcu-line__meta">{dateTime(e.at)}</span>
                  </div>
                  <div className="pxcu-line__side">
                    <span className="px-num" style={{ fontWeight: 'var(--px-fw-bold)' }}>
                      {e.points > 0 ? '+' : ''}
                      {number(e.points)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-6)' }}>
        Balances are applied automatically during checkout. This screen is read-only — adding or
        withdrawing funds is handled by the payment and refund services, not from here.
      </p>
    </div>
  );
}

export function WalletScreen() {
  return (
    <RequireCustomer>
      <WalletInner />
    </RequireCustomer>
  );
}
