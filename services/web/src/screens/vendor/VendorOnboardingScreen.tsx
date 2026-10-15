/**
 * Vendor store onboarding (FR-VEN-001/002).
 *
 * `api.vendorOnboarding` returns exactly what the BFF models — legal name,
 * display name, GSTIN, PAN, email, mobile, store status, KYC state, and two
 * recorded flags (`hasBankAccount`, `hasWarehouse`). There is no document
 * upload, no bank-verification round-trip and no KYC wizard in the endpoint, so
 * this screen does not invent one: KYC and the bank flag are REPORTED as
 * badges and setup steps, and the only writes are the six business fields,
 * each saved individually via `api.patchVendorOnboarding`.
 *
 * Each field carries its own saving/error state; a 422 field map lands on the
 * field it names, anything else lands on the field with its trace id behind a
 * disclosure. After a save the screen RE-READS the server rather than trusting
 * the draft.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Button, TextField, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import { describeError, useAsync } from '../lib/useAsync';
import { humanise, kycTone, problemFields, storeStatusTone } from './common';
import './vendor.css';

/** Exact shape of GET /vendor/onboarding (services/bff/src/repos/vendor.ts, getOnboarding). */
interface OnboardingState {
  legalName: string;
  displayName: string;
  gstin: string | null;
  pan: string | null;
  email: string;
  mobile: string;
  status: string;
  kycState: string;
  hasBankAccount: boolean;
  hasWarehouse: boolean;
}

type FieldKey = 'displayName' | 'legalName' | 'gstin' | 'pan' | 'email' | 'mobile';

interface FieldSpec {
  key: FieldKey;
  label: string;
  type?: 'text' | 'email' | 'tel';
  inputMode?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  hint?: string;
  /** Client-side email shape check — the same rule LoginScreen applies. */
  email?: boolean;
}

/** The six fields the endpoint models as editable. Nothing else is offered. */
const FIELDS: FieldSpec[] = [
  {
    key: 'displayName',
    label: 'Store display name',
    autoComplete: 'organization',
  },
  {
    key: 'legalName',
    label: 'Legal business name',
    autoComplete: 'organization',
  },
  {
    key: 'gstin',
    label: 'GSTIN',
    hint: 'Recorded as provided; leave blank to clear it.',
  },
  {
    key: 'pan',
    label: 'PAN',
    hint: 'Recorded as provided; leave blank to clear it.',
  },
  {
    key: 'email',
    label: 'Email',
    type: 'email',
    inputMode: 'email',
    autoComplete: 'email',
    email: true,
  },
  {
    key: 'mobile',
    label: 'Mobile',
    type: 'tel',
    inputMode: 'tel',
    autoComplete: 'tel',
  },
];

interface FieldError {
  message: string;
  traceId?: string;
}

export function VendorOnboardingScreen() {
  const toast = useToast();
  const onb = useAsync<OnboardingState>(
    async (signal) => (await api.vendorOnboarding(signal)) as OnboardingState,
    [],
  );

  const [drafts, setDrafts] = useState<Record<FieldKey, string>>({
    displayName: '',
    legalName: '',
    gstin: '',
    pan: '',
    email: '',
    mobile: '',
  });
  const [savingKey, setSavingKey] = useState<FieldKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, FieldError>>>({});

  // Reset the drafts to server truth whenever a fresh read lands (first load and
  // after every save). The drafts never outlive the data they came from.
  useEffect(() => {
    const d = onb.data;
    if (!d) return;
    setDrafts({
      displayName: d.displayName,
      legalName: d.legalName,
      gstin: d.gstin ?? '',
      pan: d.pan ?? '',
      email: d.email,
      mobile: d.mobile,
    });
  }, [onb.data]);

  const saveField = async (spec: FieldSpec) => {
    if (savingKey) return;
    const value = drafts[spec.key].trim();
    if (spec.email && value !== '' && !/^\S+@\S+\.\S+$/.test(value)) {
      setErrors((e) => ({ ...e, [spec.key]: { message: 'Enter a valid email address' } }));
      return;
    }
    setSavingKey(spec.key);
    setErrors((e) => ({ ...e, [spec.key]: undefined }));
    try {
      await api.patchVendorOnboarding({ [spec.key]: value });
      toast.success(`${spec.label} saved.`);
      onb.reload();
    } catch (err) {
      // A 422 field map puts the message under its field; anything else is shown
      // on this field too, with the trace id revealable (§8.3).
      const fields = problemFields(err);
      const message = fields?.[spec.key] ?? describeError(err).message;
      const traceId = err instanceof ApiProblem ? err.traceId : undefined;
      setErrors((e) => ({ ...e, [spec.key]: { message, traceId } }));
      toast.error(message);
    } finally {
      setSavingKey(null);
    }
  };

  if (onb.status === 'loading' && !onb.data) {
    return (
      <div className="px-page">
        <PageHeader title="Store setup" />
        <ScreenLoading label="Loading store setup" />
      </div>
    );
  }
  if (onb.status === 'error') {
    return (
      <div className="px-page">
        <PageHeader title="Store setup" />
        <ScreenError error={onb.error} onRetry={onb.reload} />
      </div>
    );
  }
  if (!onb.data) return null;

  const d = onb.data;
  const steps: { label: string; done: boolean }[] = [
    { label: 'Store details recorded (legal name and display name)', done: Boolean(d.legalName && d.displayName) },
    { label: 'Contact email on file', done: Boolean(d.email) },
    { label: 'Mobile on file', done: Boolean(d.mobile) },
    { label: 'GSTIN on file', done: Boolean(d.gstin) },
    { label: 'PAN on file', done: Boolean(d.pan) },
    { label: 'Bank account reported by the platform', done: d.hasBankAccount },
    { label: 'Warehouse registered', done: d.hasWarehouse },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Store setup"
        description="Your registration details and setup state. Each field saves on its own."
        crumbs={[{ label: 'Vendor', to: '/vendor' }, { label: 'Store setup' }]}
      />

      <section className="px-panel" aria-labelledby="onb-status-h">
        <div className="px-panel__head">
          <h2 id="onb-status-h">Status</h2>
        </div>
        <dl className="px-dl">
          <dt>Store</dt>
          <dd>{d.displayName}</dd>
          <dt>Store status</dt>
          <dd>
            <Badge tone={storeStatusTone(d.status)}>{humanise(d.status)}</Badge>
          </dd>
          <dt>KYC</dt>
          <dd>
            <Badge tone={kycTone(d.kycState)}>{humanise(d.kycState)}</Badge>
          </dd>
        </dl>
      </section>

      <section className="px-panel" aria-labelledby="onb-steps-h">
        <div className="px-panel__head">
          <h2 id="onb-steps-h">Setup steps</h2>
        </div>
        <ul className="px-steps">
          {steps.map((s) => (
            <li key={s.label}>
              <Badge tone={s.done ? 'success' : 'neutral'}>{s.done ? 'Complete' : 'Not yet'}</Badge>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
        <p className="px-form__aside">
          KYC and bank state are reported exactly as the platform records them. This release has
          no in-app document upload or bank-verification step, so the only controls here are the
          business fields below.
        </p>
      </section>

      <div className="px-savegrid">
        {FIELDS.map((spec) => {
          const fieldError = errors[spec.key];
          const value = drafts[spec.key];
          const clientError =
            spec.email && value.trim() !== '' && !/^\S+@\S+\.\S+$/.test(value.trim())
              ? 'Enter a valid email address'
              : undefined;
          return (
            <section className="px-panel" key={spec.key} aria-labelledby={`onb-field-${spec.key}`}>
              <div className="px-panel__head">
                <h2 id={`onb-field-${spec.key}`}>{spec.label}</h2>
              </div>
              <form
                className="px-form"
                noValidate
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void saveField(spec);
                }}
              >
                <TextField
                  label={spec.label}
                  hideLabel
                  name={`onb-${spec.key}`}
                  type={spec.type ?? 'text'}
                  inputMode={spec.inputMode}
                  autoComplete={spec.autoComplete}
                  value={value}
                  onValueChange={(v) => setDrafts((prev) => ({ ...prev, [spec.key]: v }))}
                  hint={spec.hint}
                  error={clientError}
                  serverError={fieldError?.message}
                />
                {fieldError?.traceId && (
                  <details className="px-screenstate__details">
                    <summary>Technical details</summary>
                    <p>
                      Trace ID: <code className="px-num">{fieldError.traceId}</code>
                    </p>
                  </details>
                )}
                {fieldError && !fieldError.traceId && (
                  <div className="px-row-actions__error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" /> {fieldError.message}
                  </div>
                )}
                <div className="px-form__actions">
                  {/* Disabled only while this field is submitting — §8.3. */}
                  <Button type="submit" variant="primary" loading={savingKey === spec.key}>
                    Save
                  </Button>
                </div>
              </form>
            </section>
          );
        })}
      </div>
    </div>
  );
}
