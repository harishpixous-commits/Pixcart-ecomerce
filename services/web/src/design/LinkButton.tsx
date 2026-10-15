import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './Button.css';

/**
 * A navigation element that looks like a button.
 *
 * Separate from `Button` because the semantics differ: this navigates, so it must be
 * an `<a>`/`<Link>` (middle-click, ⌘-click, screen-reader "link" announcement all
 * depend on it). It is not a second button implementation — it reuses the exact same
 * `px-btn` classes, so a visual change to a button changes this too.
 */
export interface LinkButtonProps {
  to: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  className?: string;
  /** Query string, when the target is a filtered view. */
  search?: string;
  'aria-label'?: string;
}

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  children,
  className,
  search,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      to={search ? { pathname: to, search } : to}
      className={['px-btn', `px-btn--${variant}`, `px-btn--${size}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <span className="px-btn__label">{children}</span>
    </Link>
  );
}
