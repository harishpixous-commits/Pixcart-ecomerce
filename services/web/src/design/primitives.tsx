import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Info, XCircle } from 'lucide-react';
import './primitives.css';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'progress';

/**
 * §8.4: "never colour-only status (icon+text)". Every tone therefore carries its own
 * glyph as well as its colour, so the state survives greyscale and colour-blindness.
 */
const TONE_ICON: Record<BadgeTone, ReactNode> = {
  neutral: <Info size={13} strokeWidth={2} />,
  success: <CheckCircle2 size={13} strokeWidth={2} />,
  warning: <AlertTriangle size={13} strokeWidth={2} />,
  danger: <XCircle size={13} strokeWidth={2} />,
  info: <Info size={13} strokeWidth={2} />,
  progress: <Clock size={13} strokeWidth={2} />,
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Overrides the tone glyph. Must still be non-colour meaning. */
  icon?: ReactNode;
  size?: 'sm' | 'md';
}

export function Badge({ tone = 'neutral', children, icon, size = 'md' }: BadgeProps) {
  return (
    <span className={`px-badge px-badge--${tone} px-badge--${size}`}>
      <span className="px-badge__icon" aria-hidden="true">
        {icon ?? TONE_ICON[tone]}
      </span>
      <span className="px-badge__text">{children}</span>
    </span>
  );
}

export interface CardProps {
  children: ReactNode;
  /** e1 card elevation (§8.1). */
  as?: 'div' | 'section' | 'article';
  className?: string;
  padding?: 'none' | 'sm' | 'md';
  /** Renders a heading slot with the correct landmark level. */
  title?: string;
  headingLevel?: 2 | 3 | 4;
  actions?: ReactNode;
}

export function Card({
  children,
  as: Tag = 'div',
  className,
  padding = 'md',
  title,
  headingLevel = 3,
  actions,
}: CardProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  return (
    <Tag className={['px-card', `px-card--pad-${padding}`, className ?? ''].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="px-card__head">
          {title && <Heading className="px-card__title">{title}</Heading>}
          {actions && <div className="px-card__actions">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

export interface ChipProps {
  children: ReactNode;
  /** Removable filter chip (§8.3) — renders an explicit remove control. */
  onRemove?: () => void;
  removeLabel?: string;
  selected?: boolean;
  onClick?: () => void;
}

/**
 * §8.3 search & filters: "applied filters as removable chips".
 * When `onClick` is absent the chip is not interactive and renders as a plain span.
 */
export function Chip({ children, onRemove, removeLabel, selected, onClick }: ChipProps) {
  const content = (
    <>
      <span className="px-chip__text">{children}</span>
      {onRemove && (
        <button
          type="button"
          className="px-chip__remove"
          aria-label={removeLabel ?? `Remove filter ${String(children)}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`px-chip px-chip--button ${selected ? 'is-selected' : ''}`}
        aria-pressed={selected}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return <span className="px-chip">{content}</span>;
}
