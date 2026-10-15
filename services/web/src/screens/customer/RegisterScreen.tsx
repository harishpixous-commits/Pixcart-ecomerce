/**
 * SCR-018 — Create account (FR-CUS-001).
 *
 * Same forms contract as sign-in (§8.3): validate on blur, map a 422's field
 * map onto the inputs it names, keep everything else as a form-level alert
 * with its trace id, and never disable the submit button for "incompleteness".
 *
 * The password policy is identity-svc's, not this form's: the field is a
 * password input with no client-side strength meter, because inventing a
 * client rule the server does not share is how people get told "invalid
 * password" after being told "looks strong". Whatever identity refuses is
 * shown verbatim.
 *
 * Registration goes through `AuthProvider.register`, which stores the returned
 * tokens and user the same way sign-in does — so a successful registration is
 * a signed-in session, not a bounce to /login.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Button, TextField } from '../../design';
import { ApiProblem } from '../../lib/api';
import { useAuth } from '../../app/AuthContext';
import { PageHeader } from '../lib/Screen';

export function RegisterScreen() {
  const { register, signedIn, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);

  // Already signed in — go where the visitor was headed, or home.
  if (!loading && signedIn) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const emailLooksValid = email.trim() === '' || /^\S+@\S+\.\S+$/.test(email.trim());
  const mobileLooksValid = mobile.trim() === '' || /^[0-9+\-\s]{7,15}$/.test(mobile.trim());

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await register({
        fullName: fullName.trim(),
        email: email.trim(),
        password,
        ...(mobile.trim() ? { phone: mobile.trim() } : {}),
      });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (err) {
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

  return (
    <div className="px-auth">
      <PageHeader
        title="Create your account"
        description="One account for shopping, orders, returns and the wallet."
      />
      <div className="px-auth__card">
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
            label="Full name"
            name="fullName"
            autoComplete="name"
            required
            value={fullName}
            onValueChange={setFullName}
            serverError={fieldErrors.fullName}
          />

          <TextField
            label="Email address"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onValueChange={setEmail}
            error={emailLooksValid ? undefined : 'Enter a valid email address'}
            serverError={fieldErrors.email}
          />

          <TextField
            label="Mobile number"
            name="mobile"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={mobile}
            onValueChange={setMobile}
            hint="Optional. Used for delivery contact and, if you enable it, order SMS."
            error={mobileLooksValid ? undefined : 'Enter a valid mobile number'}
            serverError={fieldErrors.mobile ?? fieldErrors.phone}
          />

          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onValueChange={setPassword}
            hint="The identity service sets the password rules; its message is shown below if this one is refused."
            serverError={fieldErrors.password}
          />

          <div className="px-form__actions">
            {/* Disabled only while submitting — §8.3. */}
            <Button type="submit" variant="primary" loading={submitting}>
              Create account
            </Button>
          </div>
        </form>

        <p className="px-auth__alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
