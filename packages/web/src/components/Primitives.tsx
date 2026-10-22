import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { IcoPrio, IcoStatus } from './Icons';

interface AvatarUser {
  name?: string | undefined;
  avatar?: string | undefined;
  color?: string | undefined;
}

export function Avatar({ user, size = 20 }: { user?: AvatarUser | null | undefined; size?: number }) {
  if (!user) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        border: '1px dashed var(--fg-faint)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-faint)', fontSize: size * 0.5,
        flexShrink: 0,
      }}>
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M2.5 14.5c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5" />
        </svg>
      </div>
    );
  }
  const initials = user.avatar ?? (user.name ? user.name.trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?');
  return (
    <div title={user.name} style={{
      width: size, height: size, borderRadius: '50%',
      background: user.color ?? 'var(--fg-dim)', color: 'var(--on-color)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.max(9, size * 0.42), fontWeight: 600, letterSpacing: '-0.02em',
      fontFamily: 'var(--font-sans)',
      flexShrink: 0,
    }}>{initials}</div>
  );
}

export function LabelPill({ label, size = 'sm' }: { label: { name: string; color: string }; size?: 'sm' | 'xs' }) {
  const tiny = size === 'xs';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: tiny ? '0 5px' : '1px 6px',
      height: tiny ? 16 : 18,
      fontSize: tiny ? 10 : 11,
      color: 'var(--fg-muted)',
      background: 'var(--bg-hover)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: label.color }} />
      {label.name}
    </span>
  );
}

export function Kbd({ keys }: { keys: string | string[] }) {
  const parts = Array.isArray(keys) ? keys : [keys];
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {parts.map((k, i) => <kbd key={i}>{k}</kbd>)}
    </span>
  );
}

type BtnVariant = 'ghost' | 'subtle' | 'primary' | 'accent' | 'danger';

export interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode;
  /** `primary` is kept as an alias of `accent` (docs/design-system.md §3.4). */
  variant?: BtnVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  kbd?: string | string[];
  active?: boolean;
  /** Busy: disabled, marked aria-busy, with a pulsing dot before the label. */
  loading?: boolean;
  style?: CSSProperties;
}

/**
 * The one button (docs/design-system.md §3.4): class-based on the `.ui-action`
 * family in styles/controls.css. Variants accent | subtle | ghost | danger,
 * sizes sm (24px) | md (28px); `icon` with no children is a square icon button.
 */
export function Btn({
  children, variant = 'ghost', size = 'sm', icon, kbd, active, disabled, loading, className, type = 'button', ...rest
}: BtnProps) {
  const resolved = variant === 'primary' ? 'accent' : variant;
  const iconOnly = Boolean(icon) && !children;
  const classes = [
    'ui-action',
    `ui-action--${resolved}`,
    `ui-action--${size}`,
    iconOnly ? 'ui-action--icon' : null,
    active ? 'is-active' : null,
    loading ? 'is-loading' : null,
    className,
  ].filter(Boolean).join(' ');
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={active ?? rest['aria-pressed']}
      className={classes}
    >
      {loading ? <span className="ui-action__spinner" aria-hidden="true" /> : null}
      {icon}
      {children ? <span>{children}</span> : null}
      {kbd ? <span aria-hidden="true" className="ui-action__kbd"><Kbd keys={kbd} /></span> : null}
    </button>
  );
}

export function PriorityIcon({ level, size = 14 }: { level: number; size?: number }) {
  const colors: Record<number, string> = {
    0: 'var(--prio-none)', 1: 'var(--prio-urgent)', 2: 'var(--prio-high)',
    3: 'var(--prio-med)', 4: 'var(--prio-low)',
  };
  return <span style={{ color: colors[level], display: 'inline-flex' }}><IcoPrio level={level} size={size} /></span>;
}

interface StatusDef {
  type: string;
  color: string;
}

export function StatusIconPrimitive({ stateType, stateColor, size = 14 }: { stateType: string; stateColor: string; size?: number }) {
  return <span style={{ display: 'inline-flex' }}><IcoStatus type={stateType} color={stateColor} size={size} /></span>;
}
