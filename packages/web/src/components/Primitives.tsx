import type { CSSProperties, MouseEvent, ReactNode } from 'react';
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
      }}>?</div>
    );
  }
  const initials = user.avatar ?? (user.name ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?');
  return (
    <div title={user.name} style={{
      width: size, height: size, borderRadius: '50%',
      background: user.color ?? 'var(--fg-dim)', color: '#0b0b0c',
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

export function Btn({
  children, variant = 'ghost', size = 'sm', icon, kbd, onClick, active, title, style,
}: {
  children?: ReactNode;
  variant?: BtnVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  kbd?: string | string[];
  onClick?: () => void;
  active?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: size === 'md' ? 28 : 24,
    padding: icon && !children ? 0 : (size === 'md' ? '0 10px' : '0 8px'),
    width: icon && !children ? (size === 'md' ? 28 : 24) : undefined,
    justifyContent: 'center',
    fontSize: 12, fontWeight: 500,
    borderRadius: 'var(--r-2)',
    transition: 'background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease)',
    border: '1px solid transparent',
    color: 'var(--fg-muted)',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
  const variants: Record<BtnVariant, CSSProperties> = {
    ghost: { background: active ? 'var(--bg-active)' : 'transparent', color: active ? 'var(--fg)' : 'var(--fg-muted)' },
    subtle: { background: 'var(--bg-hover)', color: 'var(--fg)', border: '1px solid var(--border)' },
    primary: { background: 'var(--fg)', color: 'var(--bg)', fontWeight: 500 },
    accent: { background: 'var(--accent)', color: 'var(--accent-fg)', fontWeight: 500 },
    danger: { background: 'transparent', color: 'var(--danger)', border: '1px solid var(--border)' },
  };
  const handleEnter = (e: MouseEvent<HTMLButtonElement>) => {
    if (variant === 'ghost' && !active) {
      e.currentTarget.style.background = 'var(--bg-hover)';
      e.currentTarget.style.color = 'var(--fg)';
    }
  };
  const handleLeave = (e: MouseEvent<HTMLButtonElement>) => {
    if (variant === 'ghost' && !active) {
      e.currentTarget.style.background = 'transparent';
      e.currentTarget.style.color = 'var(--fg-muted)';
    }
  };
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {icon}
      {children ? <span>{children}</span> : null}
      {kbd ? <span style={{ marginLeft: 4, opacity: 0.7 }}><Kbd keys={kbd} /></span> : null}
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
