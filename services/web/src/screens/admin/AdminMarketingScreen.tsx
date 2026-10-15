/**
 * Marketing console — coupon management (FR-MKT-001).
 *
 * Data: `api.adminCoupons` → GET /api/v1/admin/coupons →
 * `{ items: CouponRow[] }` (routes/admin.ts → repos/admin.ts listCoupons()).
 * The payload models: code, description, kind (PERCENT/FLAT), value as
 * integer basis points or integer paise, redemption window as ISO timestamps,
 * usage cap, usage count and status. Nothing else — this screen renders
 * exactly those fields and invents no targeting, scheduling or campaign flows
 * the endpoint does not model.
 *
 * Money is typed and held as integer paise (formatted once with `money()`);
 * percentages are integer basis points (formatted with `percentFromBps()`).
 * The create contract is the BFF's evidenced POST body; PATCH (api.patchCoupon)
 * mirrors that body — the BFF in this repository does not yet register a
 * PATCH route, so an edit against it surfaces the server's refusal verbatim.
 */
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil, Plus } from 'lucide-react';
import type { CouponRow } from '@contracts/dto';
import { Badge, Button, DataTable, Modal, SelectField, TextAreaField, TextField } from '../../design';
import type { Column } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { dateTime, money, percentFromBps } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import {
  couponStatusTone,
  humanise,
  toBps,
  toDateTimeLocal,
  toEpochMs,
  toPaise,
  type ItemsResponse,
} from './common';
import './admin.css';

/** How the wire value renders: PERCENT → bps, FLAT → paise. */
function valueText(row: CouponRow): string {
  return row.kind === 'PERCENT' ? percentFromBps(row.valueBps) : money(row.valuePaise);
}

/** Rupees for an edit prefill; exact for whole rupees, two decimals otherwise. */
function paiseToRupeesInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** Server 422 fields use the wire body's keys; map them onto this form's inputs. */
function mapServerErrors(fields: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = { ...fields };
  if (fields.valueBps || fields.valuePaise) {
    mapped.value = fields.valueBps ?? fields.valuePaise;
  }
  if (fields.startsAtMs) mapped.startsAt = fields.startsAtMs;
  if (fields.endsAtMs) mapped.endsAt = fields.endsAtMs;
  return mapped;
}

type FormMode = { kind: 'create' } | { kind: 'edit'; coupon: CouponRow };

function CouponModal({
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
  const editing = mode.kind === 'edit' ? mode.coupon : null;

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'PERCENT' | 'FLAT'>('PERCENT');
  const [value, setValue] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [minCart, setMinCart] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed the edit form from the real row each time the dialog opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== (editing?.id ?? '__create__')) {
    setSeededFor(editing?.id ?? '__create__');
    setCode(editing?.code ?? '');
    setDescription(editing?.description ?? '');
    setKind(editing?.kind ?? 'PERCENT');
    setValue(
      editing
        ? editing.kind === 'PERCENT'
          ? String(editing.valueBps / 100)
          : paiseToRupeesInput(editing.valuePaise)
        : '',
    );
    setMaxRedemptions(editing ? String(editing.maxRedemptions) : '');
    setMinCart('');
    setStartsAt(editing ? toDateTimeLocal(Date.parse(editing.startsAt)) : '');
    setEndsAt(editing ? toDateTimeLocal(Date.parse(editing.endsAt)) : '');
    setFieldErrors({});
    setFormError(null);
  }

  const submit = async () => {
    if (submitting) return;

    // Client pre-checks mirror the BFF's own rules (routes/admin.ts +
    // repos/admin.ts createCoupon); the server remains the authority and
    // answers 422 with a field map when something is still wrong.
    const errs: Record<string, string> = {};
    if (!code.trim()) errs.code = 'Code is required';
    if (!description.trim()) errs.description = 'Description is required';

    const amount = kind === 'PERCENT' ? toBps(value) : toPaise(value);
    if (value.trim() === '') {
      errs.value = kind === 'PERCENT' ? 'A percentage is required' : 'An amount is required';
    } else if (amount === null) {
      errs.value =
        kind === 'PERCENT'
          ? 'Enter a percentage like 10 or 12.5'
          : 'Enter rupees like 100 or 99.50 (two decimals maximum)';
    } else if (kind === 'PERCENT' && (amount < 1 || amount > 10000)) {
      errs.value = 'Percent coupons must be between 0.01% and 100%';
    } else if (kind === 'FLAT' && amount <= 0) {
      errs.value = 'Flat coupons need a positive amount';
    }

    const cap = Number(maxRedemptions);
    if (!Number.isInteger(cap) || cap < 1) errs.maxRedemptions = 'Enter a whole number of at least 1';

    const minPaise = minCart.trim() === '' ? undefined : toPaise(minCart);
    if (minCart.trim() !== '' && minPaise === null) {
      errs.minCart = 'Enter rupees like 499 (two decimals maximum)';
    }

    const startMs = toEpochMs(startsAt);
    const endMs = toEpochMs(endsAt);
    if (startMs === null) errs.startsAt = 'A start time is required';
    if (endMs === null) errs.endsAt = 'An end time is required';
    if (startMs !== null && endMs !== null && endMs <= startMs) errs.endsAt = 'Must be after the start time';

    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;

    // Body mirrors the BFF's POST contract exactly; the value field that is
    // irrelevant to the chosen kind is omitted, as the server requires.
    const body: Record<string, unknown> = {
      code: code.trim(),
      description: description.trim(),
      kind,
      maxRedemptions: cap,
      startsAtMs: startMs,
      endsAtMs: endMs,
    };
    if (amount !== null) {
      if (kind === 'PERCENT') body.valueBps = amount;
      else body.valuePaise = amount;
    }
    if (minPaise !== undefined) body.minCartPaise = minPaise;

    setSubmitting(true);
    try {
      if (mode.kind === 'edit') await api.patchCoupon(mode.coupon.id, body);
      else await api.createCoupon(body);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(mapServerErrors(err.fields));
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
      title={editing ? `Edit coupon: ${editing.code}` : 'New coupon'}
      description={
        editing
          ? 'Sends the edited coupon to the server. Nothing is applied until the server accepts it.'
          : 'The server creates the coupon and returns its id. A code can only be used once.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Create coupon'}
          </Button>
        </>
      }
    >
      <form className="px-form" onSubmit={onSubmit} noValidate>
        {formError && (
          <div className="px-screenstate px-screenstate--error" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <p className="px-screenstate__msg">{formError.message}</p>
            {formError.traceId && (
              <details className="px-screenstate__details">
                <summary>Technical details</summary>
                <p>
                  Trace ID: <code className="px-num">{formError.traceId}</code>
                </p>
              </details>
            )}
          </div>
        )}

        <TextField
          label="Code"
          name="coupon-code"
          required
          autoComplete="off"
          value={code}
          onValueChange={setCode}
          hint="Shown to customers at checkout"
          serverError={fieldErrors.code}
        />
        <TextAreaField
          label="Description"
          name="coupon-description"
          required
          rows={2}
          value={description}
          onValueChange={setDescription}
          serverError={fieldErrors.description}
        />
        <SelectField
          label="Kind"
          name="coupon-kind"
          value={kind}
          onValueChange={(v) => {
            setKind(v as 'PERCENT' | 'FLAT');
            setValue('');
          }}
          options={[
            { value: 'PERCENT', label: 'Percent — value in % off' },
            { value: 'FLAT', label: 'Flat — value in ₹ off' },
          ]}
          hint="The server validates the value field that matches the kind"
        />
        <TextField
          label={kind === 'PERCENT' ? 'Value (%)' : 'Value (₹)'}
          name="coupon-value"
          required
          inputMode="decimal"
          value={value}
          onValueChange={setValue}
          hint={
            kind === 'PERCENT'
              ? 'Stored as integer basis points: 10 means 1000 bps'
              : 'Stored as integer paise: ₹100 means 10000 paise'
          }
          error={
            value.trim() !== '' && (kind === 'PERCENT' ? toBps(value) : toPaise(value)) === null
              ? kind === 'PERCENT'
                ? 'Enter a percentage like 10 or 12.5'
                : 'Enter rupees like 100 or 99.50 (two decimals maximum)'
              : undefined
          }
          serverError={fieldErrors.value}
        />
        <TextField
          label="Usage cap (redemptions)"
          name="coupon-cap"
          required
          inputMode="numeric"
          value={maxRedemptions}
          onValueChange={setMaxRedemptions}
          serverError={fieldErrors.maxRedemptions}
        />
        <TextField
          label="Minimum cart (₹, optional)"
          name="coupon-mincart"
          inputMode="decimal"
          value={minCart}
          onValueChange={setMinCart}
          hint="Stored as integer paise"
          serverError={fieldErrors.minCart}
        />
        <div className="px-form__row">
          <TextField
            label="Starts at"
            name="coupon-starts"
            type="datetime-local"
            required
            value={startsAt}
            onValueChange={setStartsAt}
            serverError={fieldErrors.startsAt}
          />
          <TextField
            label="Ends at"
            name="coupon-ends"
            type="datetime-local"
            required
            value={endsAt}
            onValueChange={setEndsAt}
            serverError={fieldErrors.endsAt}
          />
        </div>
      </form>
    </Modal>
  );
}

export function AdminMarketingScreen() {
  const coupons = useAsync<ItemsResponse<CouponRow>>(
    async (signal) => (await api.adminCoupons(signal)) as ItemsResponse<CouponRow>,
    [],
  );
  const [modal, setModal] = useState<{ open: boolean; mode: FormMode }>({
    open: false,
    mode: { kind: 'create' },
  });

  const rows = coupons.data?.items ?? [];

  const columns: Column<CouponRow>[] = [
    {
      key: 'code',
      header: 'Code',
      value: (r) => r.code,
      render: (r) => (
        <div className="px-row-actions">
          <code className="px-num">{r.code}</code>
          <Badge tone={couponStatusTone(r.status)} size="sm">
            {humanise(r.status)}
          </Badge>
        </div>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      value: (r) => r.description,
      render: (r) => r.description,
    },
    {
      key: 'kind',
      header: 'Kind',
      value: (r) => r.kind,
      render: (r) => <Badge tone="info" size="sm">{r.kind === 'PERCENT' ? 'Percent' : 'Flat'}</Badge>,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'end',
      value: (r) => (r.kind === 'PERCENT' ? r.valueBps : r.valuePaise),
      render: (r) => <span className="px-num">{valueText(r)}</span>,
    },
    {
      key: 'window',
      header: 'Window',
      secondary: true,
      value: (r) => r.startsAt,
      render: (r) => (
        <span className="px-num">
          {dateTime(r.startsAt)} → {dateTime(r.endsAt)}
        </span>
      ),
    },
    {
      key: 'usage',
      header: 'Usage (used / cap)',
      align: 'end',
      sortable: true,
      value: (r) => r.usedCount,
      render: (r) => (
        <span className="px-num">
          {r.usedCount} / {r.maxRedemptions}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Pencil size={14} aria-hidden="true" />}
          onClick={() => setModal({ open: true, mode: { kind: 'edit', coupon: r } })}
        >
          Edit {r.code}
        </Button>
      ),
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Marketing"
        description="Coupons as the server returned them. Percentages are integer basis points and amounts are integer paise, shown here in rupees and percent."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Marketing' }]}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setModal({ open: true, mode: { kind: 'create' } })}
          >
            New coupon
          </Button>
        }
      />

      {coupons.status === 'loading' && !coupons.data && <ScreenLoading label="Loading coupons" />}
      {coupons.status === 'error' && <ScreenError error={coupons.error} onRetry={coupons.reload} />}

      {coupons.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title="No coupons yet"
            description="The server returned an empty coupon list."
            action={
              <Button variant="primary" onClick={() => setModal({ open: true, mode: { kind: 'create' } })}>
                Create the first coupon
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="Coupons"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}

      <CouponModal
        open={modal.open}
        mode={modal.mode}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onSaved={() => coupons.reload()}
      />
    </div>
  );
}
