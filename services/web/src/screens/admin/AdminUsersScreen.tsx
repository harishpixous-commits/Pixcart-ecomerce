/**
 * Staff directory (FR-ADM-002).
 *
 * Data: `api.adminUsers` → GET /api/v1/admin/users →
 * `{ items: StaffUser[] }` (routes/admin.ts → repos/admin.ts listStaff()).
 * The payload is id, email, fullName, role, status, mfaEnforced. It does not
 * carry lastSeenAt for staff, so that field is not rendered.
 *
 * Role changes are NOT offered in the edit form. The role is owned by the
 * identity service; this console shows the role as a Badge and says plainly
 * that changing it is not a form here. The edit form offers only the fields
 * the StaffUser read model evidences as staff-administrable (name, status);
 * create mirrors the read model's shape ({ fullName, email, role }) — the BFF
 * in this repository does not yet register POST/PATCH /admin/users routes, so
 * a write against it surfaces the server's refusal verbatim instead of
 * pretending the change applied.
 */
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil, Plus } from 'lucide-react';
import type { Role, StaffUser } from '@contracts/dto';
import { Badge, Button, DataTable, Modal, SelectField, TextField } from '../../design';
import type { Column } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import { humanise, roleTone, staffStatusTone, type ItemsResponse } from './common';
import './admin.css';

/** Ops roles the staff directory may create — customer/vendor are not staff roles. */
const STAFF_ROLES: Role[] = ['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'MARKETING', 'WAREHOUSE', 'DELIVERY', 'SUPPORT'];

/** Statuses the edit form may request. DELETED is terminal and never offered. */
const EDITABLE_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

function MfaBadge({ enforced }: { enforced: boolean }) {
  return enforced ? (
    <Badge tone="success" size="sm">
      Enforced
    </Badge>
  ) : (
    <Badge tone="warning" size="sm">
      Not enforced
    </Badge>
  );
}

function FormError({ error }: { error: { message: string; traceId?: string } | null }) {
  if (!error) return null;
  return (
    <div className="px-screenstate px-screenstate--error" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <p className="px-screenstate__msg">{error.message}</p>
      {error.traceId && (
        <details className="px-screenstate__details">
          <summary>Technical details</summary>
          <p>
            Trace ID: <code className="px-num">{error.traceId}</code>
          </p>
        </details>
      )}
    </div>
  );
}

type FormMode = { kind: 'create' } | { kind: 'edit'; user: StaffUser };

function StaffModal({
  open,
  mode,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: FormMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = mode.kind === 'edit' ? mode.user : null;

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('SUPPORT');
  const [status, setStatus] = useState<string>('ACTIVE');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed the edit form from the real row each time the dialog opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== (editing?.id ?? '__create__')) {
    setSeededFor(editing?.id ?? '__create__');
    setFullName(editing?.fullName ?? '');
    setEmail(editing?.email ?? '');
    setRole(editing?.role ?? 'SUPPORT');
    setStatus(editing?.status ?? 'ACTIVE');
    setFieldErrors({});
    setFormError(null);
  }

  const submit = async () => {
    if (submitting) return;

    const errs: Record<string, string> = {};
    if (!fullName.trim()) errs.fullName = 'Full name is required';
    if (mode.kind === 'create') {
      if (!email.trim()) errs.email = 'Email is required';
      else if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'Enter a valid email address';
    }
    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      if (mode.kind === 'edit') {
        // Only the fields the edit form offers — never a role change.
        await api.patchUser(mode.user.id, { fullName: fullName.trim(), status });
      } else {
        await api.createUser({ fullName: fullName.trim(), email: email.trim(), role });
      }
      onSaved();
      onClose();
    } catch (err) {
      // A refusal (403 role change, 409 duplicate email, missing route)
      // is shown verbatim — the directory is reloaded only on real success.
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(err.fields);
        setFormError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
      } else {
        setFormError({ message: 'Could not reach the server. Check your connection and try again.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title={editing ? `Edit staff: ${editing.fullName}` : 'New staff account'}
      description={
        editing
          ? 'Sends the name and status to the server. The server confirms or refuses; the directory is reloaded only after a real success.'
          : 'The server creates the staff account and returns its id.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <form className="px-form" onSubmit={onSubmit} noValidate>
        <FormError error={formError} />

        <TextField
          label="Full name"
          name="staff-name"
          required
          value={fullName}
          onValueChange={setFullName}
          serverError={fieldErrors.fullName}
        />

        {mode.kind === 'create' ? (
          <TextField
            label="Email"
            name="staff-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onValueChange={setEmail}
            serverError={fieldErrors.email}
          />
        ) : (
          <TextField
            label="Email"
            name="staff-email"
            type="email"
            value={email}
            onValueChange={setEmail}
            readOnly
            hint="The email address is not editable here"
          />
        )}

        {mode.kind === 'create' ? (
          <SelectField
            label="Role"
            name="staff-role"
            required
            value={role}
            onValueChange={(v) => setRole(v as Role)}
            options={STAFF_ROLES.map((r) => ({ value: r, label: humanise(r) }))}
            hint="The server re-checks this grant against the capability matrix"
          />
        ) : (
          <>
            <TextField
              label="Role"
              name="staff-role-ro"
              value={humanise(mode.user.role)}
              onValueChange={() => undefined}
              readOnly
              hint="Role changes are not offered here — the identity service owns roles, and this console cannot change them."
            />
            <SelectField
              label="Status"
              name="staff-status"
              value={status}
              onValueChange={setStatus}
              options={EDITABLE_STATUSES.map((s) => ({ value: s, label: humanise(s) }))}
              hint="Suspending blocks the account; the server decides whether the transition is accepted"
            />
          </>
        )}
      </form>
    </Modal>
  );
}

export function AdminUsersScreen() {
  const staff = useAsync<ItemsResponse<StaffUser>>(
    async (signal) => (await api.adminUsers(signal)) as ItemsResponse<StaffUser>,
    [],
  );
  const [modal, setModal] = useState<{ open: boolean; mode: FormMode }>({
    open: false,
    mode: { kind: 'create' },
  });

  const rows = staff.data?.items ?? [];

  const columns: Column<StaffUser>[] = [
    {
      key: 'name',
      header: 'Name',
      value: (r) => r.fullName,
      render: (r) => r.fullName,
    },
    {
      key: 'email',
      header: 'Email',
      secondary: true,
      value: (r) => r.email,
      render: (r) => <span className="px-num">{r.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      value: (r) => r.role,
      render: (r) => <Badge tone={roleTone(r.role)}>{humanise(r.role)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => <Badge tone={staffStatusTone(r.status)}>{humanise(r.status)}</Badge>,
    },
    {
      key: 'mfa',
      header: 'MFA',
      value: (r) => (r.mfaEnforced ? 'Enforced' : 'Not enforced'),
      render: (r) => <MfaBadge enforced={r.mfaEnforced} />,
    },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Pencil size={14} aria-hidden="true" />}
          onClick={() => setModal({ open: true, mode: { kind: 'edit', user: r } })}
        >
          Edit {r.fullName}
        </Button>
      ),
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Staff"
        description="The staff directory as the server returned it. Roles are shown, not edited — the identity service owns them."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Staff' }]}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setModal({ open: true, mode: { kind: 'create' } })}
          >
            New staff account
          </Button>
        }
      />

      {staff.status === 'loading' && !staff.data && <ScreenLoading label="Loading staff directory" />}
      {staff.status === 'error' && <ScreenError error={staff.error} onRetry={staff.reload} />}

      {staff.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title="No staff accounts"
            description="The server returned an empty staff list."
          />
        ) : (
          <DataTable
            caption="Staff directory"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}

      <StaffModal
        open={modal.open}
        mode={modal.mode}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onSaved={() => staff.reload()}
      />
    </div>
  );
}
