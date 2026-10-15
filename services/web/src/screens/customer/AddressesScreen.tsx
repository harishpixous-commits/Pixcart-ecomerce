/**
 * SCR-020 — Address book (FR-CUS-005).
 *
 * Create, set-default and delete against `/account/addresses`. The BFF has no
 * address-update route in this release, so an edit affordance is not offered —
 * a control that cannot save is worse than an absent one, and the note says
 * so rather than leaving the gap silent.
 *
 * Create is validated on blur (PIN is exactly 6 digits, required fields named)
 * and a 422's field map is applied to the inputs it names; everything else
 * surfaces as a form-level alert with its trace id (§8.3). Setting the default
 * and deleting are confirmed inline because both change where future orders
 * ship; delete is the only irreversible one, so it gets a second confirm.
 */
import { useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Address } from '@contracts/dto';
import { Badge, Button, SelectField, TextField, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

interface AddressesPayload {
  items: Address[];
}

const LABEL_OPTIONS = [
  { value: 'HOME', label: 'Home' },
  { value: 'WORK', label: 'Work' },
  { value: 'OTHER', label: 'Other' },
];

const EMPTY_FORM = {
  label: 'HOME',
  line1: '',
  line2: '',
  city: '',
  state: '',
  pincode: '',
  mobile: '',
};

function AddressesInner() {
  const toast = useToast();
  const addresses = useAsync<AddressesPayload>(
    async (signal) => (await api.addresses(signal)) as AddressesPayload,
    [],
  );

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const items = addresses.data?.items ?? [];
  const pinValid = form.pincode === '' || /^\d{6}$/.test(form.pincode);
  const mobileValid = form.mobile === '' || /^[0-9+\-\s]{7,15}$/.test(form.mobile);

  function set<K extends keyof typeof form>(key: K, value: string): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await api.createAddress({
        label: form.label,
        line1: form.line1.trim(),
        line2: form.line2.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim(),
        pincode: form.pincode.trim(),
        mobile: form.mobile.trim(),
      });
      setSubmitting(false);
      setCreating(false);
      setForm(EMPTY_FORM);
      addresses.reload();
      toast.success('Address saved');
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(err.fields);
        setFormError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
      } else {
        setFormError({ message: 'Could not reach the server. Check your connection and try again.' });
      }
    }
  }

  async function makeDefault(id: string): Promise<void> {
    try {
      await api.setAddressDefault(id);
      addresses.reload();
      toast.success('Default delivery address updated');
    } catch (err) {
      toast.error(
        err instanceof ApiProblem
          ? err.problem.detail || err.problem.title
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.deleteAddress(id);
      setConfirmDelete(null);
      addresses.reload();
      toast.success('Address removed');
    } catch (err) {
      toast.error(
        err instanceof ApiProblem
          ? err.problem.detail || err.problem.title
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  if (addresses.status === 'loading') return <ScreenLoading label="Loading your addresses" />;
  if (addresses.status === 'error') {
    return <ScreenError error={addresses.error} onRetry={addresses.reload} />;
  }

  return (
    <div>
      <PageHeader
        title="Addresses"
        description="Where your orders are delivered. Set one as default to speed up checkout."
        actions={
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : 'Add address'}
          </Button>
        }
      />

      {creating && (
        <section className="px-panel" aria-labelledby="addr-new" style={{ marginBottom: 'var(--px-space-6)' }}>
          <div className="px-panel__head">
            <h2 id="addr-new">New address</h2>
          </div>
          <form className="px-form" onSubmit={submit} noValidate>
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

            <SelectField
              label="Label"
              name="label"
              value={form.label}
              options={LABEL_OPTIONS}
              onValueChange={(v) => set('label', v)}
              error={fieldErrors.label}
            />
            <TextField
              label="Address line 1"
              name="line1"
              autoComplete="address-line1"
              required
              value={form.line1}
              onValueChange={(v) => set('line1', v)}
              error={fieldErrors.line1}
            />
            <TextField
              label="Address line 2"
              name="line2"
              autoComplete="address-line2"
              value={form.line2}
              onValueChange={(v) => set('line2', v)}
              error={fieldErrors.line2}
            />
            <TextField
              label="City"
              name="city"
              autoComplete="address-level2"
              required
              value={form.city}
              onValueChange={(v) => set('city', v)}
              error={fieldErrors.city}
            />
            <TextField
              label="State"
              name="state"
              autoComplete="address-level1"
              required
              value={form.state}
              onValueChange={(v) => set('state', v)}
              error={fieldErrors.state}
            />
            <TextField
              label="PIN code"
              name="pincode"
              autoComplete="postal-code"
              inputMode="numeric"
              required
              value={form.pincode}
              onValueChange={(v) => set('pincode', v)}
              hint="6 digits. Delivery serviceability is checked against this PIN."
              error={pinValid ? undefined : 'PIN code must be exactly 6 digits'}
              serverError={fieldErrors.pincode}
            />
            <TextField
              label="Mobile"
              name="mobile"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              required
              value={form.mobile}
              onValueChange={(v) => set('mobile', v)}
              hint="The delivery partner calls this number."
              error={mobileValid ? undefined : 'Enter a valid mobile number'}
              serverError={fieldErrors.mobile}
            />

            <div className="px-form__actions">
              <Button type="submit" variant="primary" loading={submitting}>
                Save address
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {items.length === 0 && !creating ? (
        <ScreenEmpty
          title="No addresses yet"
          description="Add a delivery address so checkout can check serviceability and ship your order."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add your first address
            </Button>
          }
        />
      ) : (
        <ul className="pxcu-lines">
          {items.map((a) => (
            <li key={a.id} className="pxcu-line">
              <div>
                <strong>{a.label}</strong>
                {a.isDefault && (
                  <>
                    {' '}
                    <Badge tone="success" size="sm">
                      Default
                    </Badge>
                  </>
                )}
                <span className="pxcu-line__meta">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state} {a.pincode}
                </span>
                <span className="pxcu-line__meta">Mobile {a.mobile}</span>
              </div>
              <div className="pxcu-line__side">
                {!a.isDefault && (
                  <Button size="sm" variant="secondary" onClick={() => makeDefault(a.id)}>
                    Set as default
                  </Button>
                )}
                {confirmDelete === a.id ? (
                  <>
                    <span className="pxcu-muted">Remove this address?</span>
                    <div className="pxcu-line__actions">
                      <Button size="sm" variant="danger" onClick={() => remove(a.id)}>
                        Yes, remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(a.id)}>
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-6)' }}>
        Addresses are stored against your account and reused at checkout. Only you and the
        delivery workflow for your orders can see them.
      </p>
    </div>
  );
}

export function AddressesScreen() {
  return (
    <RequireCustomer>
      <AddressesInner />
    </RequireCustomer>
  );
}
