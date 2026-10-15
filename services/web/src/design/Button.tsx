import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonVariant =
  | 'primary' /* green CTA — §8.1: green = primary CTA & success accents */
  | 'secondary' /* navy — §8.1: navy = structure / actions-secondary */
  | 'ghost'
  | 'danger'
  | 'link';

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner and marks the control busy. */
  loading?: boolean;
  /**
   * Leading icon. §8.1: icons are always paired with a label or an aria-label — an
   * icon-only button must pass `aria-label`, which `IconButton` enforces instead.
   */
  icon?: ReactNode;
  /** Trailing icon, e.g. a chevron. */
  iconEnd?: ReactNode;
  block?: boolean;
}

/**
 * §8.4 target size: every button is at least 24×24 CSS px, and 44 px on mobile
 * (`--px-target-touch` is applied by the media query in Button.css).
 *
 * §8.3 forms: a primary button is disabled ONLY while submitting — never because a
 * form is "incomplete". Use `loading` for that; do not disable for validation.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconEnd,
    block = false,
    disabled,
    children,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = [
    'px-btn',
    `px-btn--${variant}`,
    `px-btn--${size}`,
    block ? 'px-btn--block' : '',
    loading ? 'is-loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="px-btn__spinner" aria-hidden="true" />}
      {!loading && icon && (
        <span className="px-btn__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="px-btn__label">{children}</span>
      {iconEnd && (
        <span className="px-btn__icon px-btn__icon--end" aria-hidden="true">
          {iconEnd}
        </span>
      )}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  /** §8.1: icons always paired with label or aria-label — required here. */
  'aria-label': string;
  children: ReactNode;
}

/** Icon-only button. The `aria-label` is mandatory by type, not by convention. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ children, className, ...rest }, ref) {
    return (
      <Button
        ref={ref}
        variant="ghost"
        className={['px-btn--icon-only', className ?? ''].filter(Boolean).join(' ')}
        {...rest}
      >
        {children}
      </Button>
    );
  },
);
