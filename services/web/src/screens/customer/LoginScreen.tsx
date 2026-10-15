/**
 * SCR-015 — Sign in.
 *
 * Vol. 8 §8.3 forms contract, applied in full:
 *  - validate on blur, not on every keystroke (`TextField` owns that)
 *  - a primary button is disabled ONLY while submitting, never because the form is
 *    "incomplete"
 *  - server errors are mapped onto the fields they belong to; anything else becomes a
 *    form-level alert carrying its trace id
 *
 * The password is never echoed, never logged, and never placed in the URL. The client
 * does not decide whether the credentials are valid — identity-svc does, and its
 * verdict (including how many attempts remain before lockout) is shown verbatim.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Button, TextField } from '../../design';
import { ApiProblem } from '../../lib/api';
import { useAuth } from '../../app/AuthContext';
import { PageHeader } from '../lib/Screen';

export function LoginScreen() {
  const { login, signedIn, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);

  // Already signed in — go where the visitor was headed, or home.
  if (!loading && signedIn) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      await login(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiProblem) {
        // 422 carries a field map; anything else is a form-level problem (bad
        // credentials, locked account, identity unavailable).
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
      <PageHeader title="Sign in" description="Use the email address you registered with." />
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
            label="Email address"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onValueChange={setEmail}
            error={email.trim() === '' ? undefined : !/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter a valid email address' : undefined}
            serverError={fieldErrors.email}
          />

          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onValueChange={setPassword}
            serverError={fieldErrors.password}
          />

          <div className="px-form__actions">
            {/* Disabled only while submitting — §8.3. */}
            <Button type="submit" variant="primary" loading={submitting}>
              Sign in
            </Button>
          </div>
        </form>

        <p className="px-auth__alt">
          New to PixCart? <Link to="/register">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
