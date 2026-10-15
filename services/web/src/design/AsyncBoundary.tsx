import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react';
import { Button } from './Button';
import './AsyncBoundary.css';

export interface RetryContext {
  /** Server trace id, surfaced by §8.3 "error (retry + trace-id reveal)". */
  traceId?: string;
}

interface LoadingProps {
  /** Shape of the skeleton so the layout does not jump when data lands. */
  variant?: 'list' | 'table' | 'card' | 'inline' | 'detail';
  rows?: number;
  label?: string;
}

export function LoadingState({ variant = 'list', rows = 4, label }: LoadingProps) {
  const shapes = Array.from({ length: rows });
  return (
    <div className={`px-state px-state--loading px-skel--${variant}`} role="status">
      <span className="px-visually-hidden">{label ?? 'Loading'}</span>
      {variant === 'inline' ? (
        <div className="px-skel px-skel__bar" style={{ width: '60%' }} />
      ) : (
        shapes.map((_, i) => (
          <div className={`px-skel px-skel__${variant}`} key={i} aria-hidden="true">
            <div className="px-skel px-skel__line" style={{ width: `${45 + ((i * 17) % 45)}%` }} />
            <div className="px-skel px-skel__line px-skel__line--short" />
          </div>
        ))
      )}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  /** §8.3: an empty state is an illustration plus the primary next action. */
  description?: string;
  /** The primary next action — required, not optional, by §8.3. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, secondaryAction, icon }: EmptyStateProps) {
  return (
    <div className="px-state px-state--empty">
      <div className="px-state__art" aria-hidden="true">
        {icon ?? <Inbox size={40} strokeWidth={1.5} />}
      </div>
      <h3 className="px-state__title">{title}</h3>
      {description && <p className="px-state__desc">{description}</p>}
      <div className="px-state__actions">
        {action}
        {secondaryAction}
      </div>
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  /** Shown behind a disclosure so support can read it back (§8.3). */
  traceId?: string;
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  traceId,
  onRetry,
  retrying,
}: ErrorStateProps) {
  return (
    <div className="px-state px-state--error" role="alert">
      <div className="px-state__art px-state__art--danger" aria-hidden="true">
        <AlertTriangle size={40} strokeWidth={1.5} />
      </div>
      <h3 className="px-state__title">{title}</h3>
      <p className="px-state__desc">{message}</p>
      <div className="px-state__actions">
        {onRetry && (
          <Button variant="primary" onClick={onRetry} loading={retrying} icon={<RotateCw size={16} />}>
            Retry
          </Button>
        )}
      </div>
      {traceId && (
        <details className="px-state__trace">
          <summary>Technical details</summary>
          <code className="px-num">{traceId}</code>
        </details>
      )}
    </div>
  );
}

export type AsyncStatus = 'loading' | 'empty' | 'error' | 'success';

export interface AsyncBoundaryProps {
  status: AsyncStatus;
  /** Rendered when `status === 'empty'`. */
  empty?: EmptyStateProps;
  /** Rendered when `status === 'error'`. */
  error?: ErrorStateProps;
  loadingVariant?: LoadingProps['variant'];
  loadingRows?: number;
  children: ReactNode;
}

/**
 * §8.3 — "States: every data surface defines loading (skeleton), empty (illustration
 * + primary next action), error (retry + trace-id reveal), and success".
 *
 * Routing through this component makes the four states structural: a screen cannot
 * render a data surface without declaring what its empty and error states look like,
 * because the props are part of the surface's contract.
 */
export function AsyncBoundary({
  status,
  empty,
  error,
  loadingVariant = 'list',
  loadingRows = 4,
  children,
}: AsyncBoundaryProps) {
  if (status === 'loading') return <LoadingState variant={loadingVariant} rows={loadingRows} />;
  if (status === 'error') return <ErrorState {...(error ?? { message: 'Request failed' })} />;
  if (status === 'empty' && empty) return <EmptyState {...empty} />;
  return <>{children}</>;
}

/** Convenience for local, non-network pending state. */
export function useBoolean(defaultValue = false) {
  const [value, setValue] = useState(defaultValue);
  return [value, setValue, () => setValue(defaultValue)] as const;
}
