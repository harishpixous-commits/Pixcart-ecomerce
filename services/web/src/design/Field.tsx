import { useId, useState } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import './Field.css';

interface FieldShellProps {
  id: string;
  label: string;
  hint?: string;
  /** Client-side validation message. Shown on blur (§8.3), not on every keystroke. */
  error?: string;
  required?: boolean;
  children: ReactNode;
  /** Hides the visual label but keeps it for assistive tech. */
  hideLabel?: boolean;
}

function FieldShell({ id, label, hint, error, required, children, hideLabel }: FieldShellProps) {
  return (
    <div className={`px-field ${error ? 'is-invalid' : ''}`}>
      <label className={`px-field__label ${hideLabel ? 'px-visually-hidden' : ''}`} htmlFor={id}>
        {label}
        {required && (
          <span className="px-field__req" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="px-visually-hidden"> (required)</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="px-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="px-field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  const ids = [error ? `${id}-error` : '', hint && !error ? `${id}-hint` : ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'onChange'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: string;
  /** Set by the form on blur; empty/undefined renders valid. */
  error?: string;
  hideLabel?: boolean;
  /** Server field errors mapped from the E-VAL-001 payload (§8.3). */
  serverError?: string;
}

/**
 * §8.3 forms: inline validation on blur — so `error` is applied when the field has
 * been touched and then blurred, never while the user is still typing their first
 * character.
 */
export function TextField({
  label,
  value,
  onValueChange,
  hint,
  error,
  serverError,
  hideLabel,
  required,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const id = rest.name ? `f-${rest.name}` : autoId;
  const [touched, setTouched] = useState(false);
  const shown = touched ? (error ?? serverError) : serverError;

  return (
    <FieldShell id={id} label={label} hint={hint} error={shown} required={required} hideLabel={hideLabel}>
      <input
        {...rest}
        id={id}
        className="px-input"
        value={value}
        required={required}
        aria-invalid={shown ? true : undefined}
        aria-describedby={describedBy(id, hint, shown)}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={(e) => {
          setTouched(true);
          rest.onBlur?.(e);
        }}
      />
    </FieldShell>
  );
}

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'onChange'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: string;
  error?: string;
  serverError?: string;
  hideLabel?: boolean;
}

export function TextAreaField({
  label,
  value,
  onValueChange,
  hint,
  error,
  serverError,
  hideLabel,
  required,
  ...rest
}: TextAreaFieldProps) {
  const autoId = useId();
  const id = rest.name ? `f-${rest.name}` : autoId;
  const [touched, setTouched] = useState(false);
  const shown = touched ? (error ?? serverError) : serverError;

  return (
    <FieldShell id={id} label={label} hint={hint} error={shown} required={required} hideLabel={hideLabel}>
      <textarea
        {...rest}
        id={id}
        className="px-input px-input--area"
        value={value}
        required={required}
        aria-invalid={shown ? true : undefined}
        aria-describedby={describedBy(id, hint, shown)}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={(e) => {
          setTouched(true);
          rest.onBlur?.(e);
        }}
      />
    </FieldShell>
  );
}

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'onChange'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  error?: string;
  hideLabel?: boolean;
}

export function SelectField({
  label,
  value,
  onValueChange,
  options,
  hint,
  error,
  hideLabel,
  required,
  ...rest
}: SelectFieldProps) {
  const autoId = useId();
  const id = rest.name ? `f-${rest.name}` : autoId;

  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel}>
      <select
        {...rest}
        id={id}
        className="px-input px-input--select"
        value={value}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
