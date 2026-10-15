/**
 * Audit hash-chain log (FR-ADM-013).
 *
 * Data: `api.adminAudit` → GET /api/v1/admin/audit →
 * `{ items: AuditEvent[] }` (routes/admin.ts → repos/admin.ts listAudit()).
 * Each event carries actorType/actorId/actorName, action, entityType/entityId,
 * optional justification, createdAt and `chainValid`.
 *
 * The chain: every event stores SHA-256(prev event's hash ‖ canonical
 * payload) — the first event hashes 32 zero bytes (genesis). The server
 * RECOMPUTES the whole prefix from genesis on every single read of this
 * endpoint, so `chainValid` is not a stale flag: it is the verdict of a full
 * re-verification performed when this page loaded. Deleting or editing any
 * stored entry breaks the hash from that point on, which invalidates that
 * event and every event after it.
 *
 * Status is never colour-only (§8.4): a valid chain is a success badge with a
 * check glyph, a broken chain a danger badge with a cross glyph.
 *
 * The "Re-verify" affordance is honest because the endpoint actually
 * verifies: it simply re-fetches, and the server recomputes the chain again.
 * There is no client-side re-verification, and none is claimed.
 */
import { Check, RefreshCw, X } from 'lucide-react';
import type { AuditEvent } from '@contracts/dto';
import { Badge, Button, DataTable } from '../../design';
import type { Column } from '../../design';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import { humanise, type ItemsResponse } from './common';
import './admin.css';

/** Chain verdict as a badge with a glyph as well as colour (§8.4). */
function ChainBadge({ valid }: { valid: boolean }) {
  return valid ? (
    <Badge tone="success" icon={<Check size={13} strokeWidth={2.5} aria-hidden="true" />}>
      Chain valid
    </Badge>
  ) : (
    <Badge tone="danger" icon={<X size={13} strokeWidth={2.5} aria-hidden="true" />}>
      Chain broken
    </Badge>
  );
}

export function AdminAuditScreen() {
  const audit = useAsync<ItemsResponse<AuditEvent>>(
    async (signal) => (await api.adminAudit(signal)) as ItemsResponse<AuditEvent>,
    [],
  );

  const rows = audit.data?.items ?? [];
  const brokenCount = rows.filter((r) => !r.chainValid).length;

  const columns: Column<AuditEvent>[] = [
    {
      key: 'when',
      header: 'When',
      sortable: true,
      value: (r) => r.createdAt,
      render: (r) => <span className="px-num">{dateTime(r.createdAt)}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      value: (r) => r.actorName,
      render: (r) => (
        <div className="px-row-actions">
          <span>{r.actorName}</span>
          <Badge tone="neutral" size="sm">
            {humanise(r.actorType)}
          </Badge>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      value: (r) => r.action,
      render: (r) => <code className="px-num">{r.action}</code>,
    },
    {
      key: 'target',
      header: 'Target',
      value: (r) => `${r.entityType}:${r.entityId}`,
      render: (r) => (
        <div className="px-row-actions">
          <Badge tone="info" size="sm">
            {humanise(r.entityType)}
          </Badge>
          <code className="px-num">{r.entityId}</code>
        </div>
      ),
    },
    {
      key: 'justification',
      header: 'Justification',
      secondary: true,
      value: (r) => r.justification ?? '',
      render: (r) => r.justification ?? <span className="px-text-muted">—</span>,
    },
    {
      key: 'chain',
      header: 'Chain integrity',
      value: (r) => (r.chainValid ? 'Valid' : 'Broken'),
      render: (r) => <ChainBadge valid={r.chainValid} />,
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Audit log"
        description="Every recorded staff action, in the order the server stored it, with the hash-chain verdict computed at load time."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Audit log' }]}
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} aria-hidden="true" />}
            loading={audit.status === 'loading' && audit.data !== null}
            onClick={audit.reload}
          >
            Re-verify chain
          </Button>
        }
      />

      <div className="px-note" role="note">
        <p>
          Each event stores a hash of the previous event's hash together with its own payload
          (SHA-256 over the canonical encoding; the first event hashes 32 zero bytes). Editing or
          deleting any entry breaks the hash from that point on, so a <strong>Chain broken</strong>{' '}
          badge means that event — and every event after it — can no longer be trusted.
        </p>
        <p>
          Verification runs on the <strong>server</strong> every time this list is read: it
          recomputes the whole chain from the first event. The badge shows that verdict; the
          &ldquo;Re-verify chain&rdquo; button simply asks the server to read and re-verify again.
        </p>
      </div>

      {audit.status === 'loading' && !audit.data && <ScreenLoading label="Loading audit log" />}
      {audit.status === 'error' && <ScreenError error={audit.error} onRetry={audit.reload} />}

      {audit.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title="No audit events"
            description="The server returned an empty audit log."
          />
        ) : (
          <>
            {brokenCount > 0 && (
              <div className="px-screenstate px-screenstate--error" role="alert">
                <p className="px-screenstate__msg">
                  {brokenCount} of {rows.length} events failed chain verification. Treat every event
                  from the first broken link onwards as untrusted and investigate the database
                  directly — this console cannot repair the chain.
                </p>
              </div>
            )}
            <DataTable
              caption="Audit events with hash-chain integrity"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              denseByDefault
            />
          </>
        ))}
    </div>
  );
}
