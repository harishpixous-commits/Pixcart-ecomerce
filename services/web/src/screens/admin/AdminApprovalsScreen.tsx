/**
 * Admin console — approval queue (FR-ADM-004).
 *
 * Data source: GET /api/v1/admin/approvals (`api.adminApprovals`) →
 * `{ items: ApprovalCase[] }`. Decisions: POST /api/v1/admin/approvals/:id/decide
 * (`api.decideApproval`) with `{ decision: 'APPROVED' | 'REJECTED' }`.
 *
 * §8.3: a decision is irreversible — the server refuses a second decision with
 * 409 NOT_PENDING — so both Approve and Reject go through a typed-word
 * confirmation inside a non-dismissible Modal: the operator types the exact
 * word shown (APPROVE / REJECT) and the confirm button stays disabled until it
 * matches. The server's outcome, including refusals (case already decided, case
 * not found), is shown verbatim with its trace id; nothing is optimistically
 * marked decided.
 *
 * Contract honesty: `decideApproval` in the BFF only understands `VENDOR:`
 * prefixed ids and product approval cases. A REVIEW case has no decision route,
 * so review rows are listed for visibility but carry no decision buttons —
 * offering them would be a dead button that always 404s.
 */
import { useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import type { ApprovalCase } from '@contracts/dto';
import { Badge, Button, Chip, DataTable, Modal, TextField, useToast } from '../../design';
import type { BadgeTone, Column } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import './admin.css';

interface ApprovalsResponse {
  items: ApprovalCase[];
}

/** Runtime states include 'PENDING' (the BFF stores that on product cases). */
function stateTone(state: string): BadgeTone {
  switch (state) {
    case 'APPROVED':
      return 'success';
    case 'REJECTED':
      return 'danger';
    case 'ESCALATED':
      return 'warning';
    default: // OPEN / PENDING
      return 'progress';
  }
}

function kindTone(kind: ApprovalCase['kind']): BadgeTone {
  switch (kind) {
    case 'VENDOR':
      return 'info';
    case 'PRODUCT':
      return 'neutral';
    case 'REVIEW':
      return 'warning';
  }
}

type Decision = 'APPROVED' | 'REJECTED';

export function AdminApprovalsScreen() {
  const toast = useToast();
  const { status, data, error, reload } = useAsync<ApprovalsResponse>(
    (signal) => api.adminApprovals(signal) as Promise<ApprovalsResponse>,
    [],
  );

  // The case currently in the confirmation modal, and which decision it carries.
  const [pending, setPending] = useState<{ row: ApprovalCase; decision: Decision } | null>(null);
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<{ message: string; traceId?: string } | null>(null);

  const confirmWord = pending ? (pending.decision === 'APPROVED' ? 'APPROVE' : 'REJECT') : '';
  const wordMatches = typed.trim() === confirmWord;

  const openDecision = (row: ApprovalCase, decision: Decision) => {
    setPending({ row, decision });
    setTyped('');
    setWriteError(null);
  };

  const closeDecision = () => {
    if (submitting) return;
    setPending(null);
    setTyped('');
    setWriteError(null);
  };

  const submitDecision = async () => {
    if (!pending || !wordMatches || submitting) return;
    setSubmitting(true);
    setWriteError(null);
    try {
      const result = (await api.decideApproval(pending.row.id, { decision: pending.decision })) as {
        id: string;
        decision: Decision;
      };
      // Surface the server's verdict, not our intent: it echoes the stored decision.
      toast.success(`Case ${result.id} recorded as ${result.decision}.`);
      setPending(null);
      setTyped('');
      reload();
    } catch (err) {
      if (err instanceof ApiProblem) {
        // Refusals (409 NOT_PENDING, 404, 403) are shown verbatim with the trace id.
        setWriteError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
        // A "case already decided" means our list is stale — refresh behind the modal.
        if (err.status === 409) reload();
      } else {
        setWriteError({
          message: 'Could not reach the server. The decision was NOT recorded — try again.',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const columns: Column<ApprovalCase>[] = [
    {
      key: 'kind',
      header: 'Kind',
      value: (r) => r.kind,
      render: (r) => <Badge tone={kindTone(r.kind)}>{r.kind}</Badge>,
    },
    {
      key: 'subject',
      header: 'Subject',
      sortable: true,
      value: (r) => r.subjectLabel,
      render: (r) => (
        <>
          <div>{r.subjectLabel}</div>
          <div className="px-tree__slug px-num">{r.subjectId}</div>
        </>
      ),
    },
    {
      key: 'submittedAt',
      header: 'Submitted',
      sortable: true,
      value: (r) => r.submittedAt,
      render: (r) => <span className="px-num">{dateTime(r.submittedAt)}</span>,
    },
    {
      key: 'state',
      header: 'State',
      sortable: true,
      value: (r) => r.state,
      render: (r) => <Badge tone={stateTone(r.state)}>{r.state}</Badge>,
    },
    {
      key: 'risk',
      header: 'Risk flags',
      render: (r) =>
        r.riskFlags.length === 0 ? (
          <span className="px-text-muted">None</span>
        ) : (
          <span className="px-admin-chips" style={{ margin: 0 }}>
            {r.riskFlags.map((flag) => (
              <Chip key={flag}>{flag}</Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'actions',
      header: 'Decision',
      render: (r) => {
        if (r.kind === 'REVIEW') {
          return (
            <span className="px-tree__slug">
              No decision route for review cases in this release
            </span>
          );
        }
        const decided = r.state === 'APPROVED' || r.state === 'REJECTED';
        if (decided) return <span className="px-tree__slug">Already decided</span>;
        return (
          <span className="px-form__actions">
            <Button size="sm" variant="primary" onClick={() => openDecision(r, 'APPROVED')}>
              Approve
            </Button>
            <Button size="sm" variant="danger" onClick={() => openDecision(r, 'REJECTED')}>
              Reject
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Approval queue"
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Approvals' }]}
        description="Pending vendor stores and product listings awaiting an operator decision. Every decision is irreversible and is written to the audit log."
      />

      {status === 'loading' && <ScreenLoading label="Loading approval queue" />}
      {status === 'error' && <ScreenError error={error} onRetry={reload} />}

      {status === 'success' && data && (
        <>
          {data.items.length === 0 ? (
            <ScreenEmpty
              title="Nothing to approve"
              description="No vendor stores or product listings are waiting for a decision."
            />
          ) : (
            <DataTable
              columns={columns}
              rows={data.items}
              rowKey={(r) => r.id}
              caption="Approval cases awaiting an operator decision"
              emptyMessage="No approval cases"
            />
          )}
        </>
      )}

      {/* §8.3 typed-word confirmation for an irreversible admin operation.
          dismissible={false}: backdrop/Escape cannot dismiss it; Cancel and the
          close button still work. */}
      <Modal
        open={pending !== null}
        onClose={closeDecision}
        dismissible={false}
        title={pending?.decision === 'APPROVED' ? 'Approve this case?' : 'Reject this case?'}
        description={
          pending
            ? `${pending.row.kind} — ${pending.row.subjectLabel}. This decision is final: the server refuses a second decision on the same case.`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeDecision} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant={pending?.decision === 'APPROVED' ? 'primary' : 'danger'}
              onClick={submitDecision}
              loading={submitting}
              disabled={!wordMatches}
            >
              {pending?.decision === 'APPROVED' ? 'Approve' : 'Reject'}
            </Button>
          </>
        }
      >
        {writeError && (
          <div className="px-screenstate px-screenstate--error" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <p className="px-screenstate__msg">{writeError.message}</p>
            {writeError.traceId && (
              <details className="px-screenstate__details">
                <summary>Technical details</summary>
                <p>
                  Trace ID: <code className="px-num">{writeError.traceId}</code>
                </p>
              </details>
            )}
          </div>
        )}
        <form
          className="px-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitDecision();
          }}
          noValidate
        >
          <p>
            To confirm, type <strong className="px-num">{confirmWord}</strong> exactly in the box
            below. The confirm button enables only when it matches.
          </p>
          <TextField
            label={`Type ${confirmWord} to confirm`}
            name="confirmWord"
            autoComplete="off"
            spellCheck={false}
            required
            value={typed}
            onValueChange={setTyped}
            error={typed !== '' && !wordMatches ? `Must match ${confirmWord} exactly` : undefined}
          />
          {/* Submit via Enter lives on the form; the explicit button in the footer
              performs the same call so there is one code path. */}
          <button type="submit" className="px-visually-hidden" disabled={!wordMatches}>
            {pending?.decision === 'APPROVED' ? 'Approve' : 'Reject'}
          </button>
        </form>
      </Modal>

      {/* Screen-reader announcement of the glyph semantics used in the table. */}
      <span className="px-visually-hidden">
        <Check aria-hidden="true" /> indicates approval; <X aria-hidden="true" /> indicates
        rejection.
      </span>
    </div>
  );
}
