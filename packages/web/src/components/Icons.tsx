import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function IcoSearch({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3"/><path d="m9 9 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
}

export function IcoPlus({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
}

export function IcoInbox({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M2 8v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8m-10 0 1.5-4h7L12 8m-10 0h3l1 1.5h2L9 8h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>);
}

export function IcoIssues({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>);
}

export function IcoViews({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><rect x="2" y="3" width="10" height="2" rx="0.5" fill="currentColor"/><rect x="2" y="6.5" width="10" height="1.3" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="2" y="9.3" width="10" height="1.3" rx="0.5" fill="currentColor" opacity="0.4"/></svg>);
}

export function IcoProject({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M7 2a5 5 0 0 1 0 10V2Z" fill="currentColor"/></svg>);
}

export function IcoTeam({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><circle cx="5" cy="6" r="2" stroke="currentColor" strokeWidth="1.2"/><circle cx="10" cy="6" r="2" stroke="currentColor" strokeWidth="1.2"/><path d="M2 12c0-1.7 1.3-3 3-3s3 1.3 3 3M8 12c0-1.7 1.3-3 3-3s3 1.3 3 3" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>);
}

export function IcoSettings({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2"/><path d="M7 1v2M7 11v2M1 7h2M11 7h2M3 3l1.4 1.4M9.6 9.6 11 11M3 11l1.4-1.4M9.6 4.4 11 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>);
}

export function IcoChevL({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="m8 3-4 4 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoChevR({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="m6 3 4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoChevD({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="m3 6 4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoFilter({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M2 3h10l-4 5v4l-2-1V8L2 3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>);
}

export function IcoSort({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M4 2v10m0 0-2-2m2 2 2-2M10 12V2m0 0-2 2m2-2 2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoList({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>);
}

export function IcoBoard({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><rect x="2" y="2" width="3" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="6" y="2" width="3" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="10" y="2" width="2.5" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.2"/></svg>);
}

export function IcoMore({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" {...rest}><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>);
}

export function IcoClose({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="m3 3 8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>);
}

export function IcoCheck({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="m3 7 3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoArrowUp({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M7 11V3m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoArrowDn({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M7 3v8m0 0 3-3m-3 3-3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoCycle({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M2 7a5 5 0 0 1 9-3m1 3a5 5 0 0 1-9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M11 2v2h-2m-6 8v-2h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>);
}

export function IcoLink({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M6 8a2 2 0 0 0 3 0l2.5-2.5a2 2 0 0 0-3-3L7 4M8 6a2 2 0 0 0-3 0L2.5 8.5a2 2 0 0 0 3 3L7 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>);
}

export function IcoCopy({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><rect x="2" y="4" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M5 4V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" strokeWidth="1.2"/></svg>);
}

export function IcoLabel({ size = 14, ...rest }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14" fill="none" {...rest}><path d="M7.5 2H11a1 1 0 0 1 1 1v3.5a1 1 0 0 1-.3.7l-5 5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 .7-.3Z" stroke="currentColor" strokeWidth="1.2"/><circle cx="9.2" cy="4.8" r="0.7" fill="currentColor"/></svg>);
}

export function IcoGoogle({ size = 14 }: IconProps) {
  return (<svg width={size} height={size} viewBox="0 0 14 14"><path d="M13.7 7.2c0-.5 0-.9-.1-1.3H7v2.5h3.8a3.2 3.2 0 0 1-1.4 2.1v1.7h2.3c1.3-1.2 2-3 2-5Z" fill="#4285F4"/><path d="M7 14c1.9 0 3.5-.6 4.7-1.7l-2.3-1.7c-.6.4-1.4.7-2.4.7-1.8 0-3.4-1.2-4-2.9H.6v1.8A7 7 0 0 0 7 14Z" fill="#34A853"/><path d="M3 8.4a4.2 4.2 0 0 1 0-2.7V3.9H.6a7 7 0 0 0 0 6.2L3 8.4Z" fill="#FBBC04"/><path d="M7 2.8c1 0 1.9.3 2.6 1l2-2A7 7 0 0 0 .6 3.9L3 5.7c.6-1.7 2.2-2.9 4-2.9Z" fill="#EA4335"/></svg>);
}

export function IcoPrio({ level, size = 14 }: { level: number; size?: number }) {
  if (level === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label="No priority">
        <rect x="2" y="6.5" width="2.2" height="1" rx="0.3" fill="currentColor" opacity="0.5" />
        <rect x="5.9" y="6.5" width="2.2" height="1" rx="0.3" fill="currentColor" opacity="0.5" />
        <rect x="9.8" y="6.5" width="2.2" height="1" rx="0.3" fill="currentColor" opacity="0.5" />
      </svg>
    );
  }
  if (level === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label="Urgent">
        <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
        <rect x="6.3" y="4" width="1.4" height="4.5" rx="0.5" fill="var(--bg)" />
        <rect x="6.3" y="9.2" width="1.4" height="1.4" rx="0.5" fill="var(--bg)" />
      </svg>
    );
  }
  const bars = level === 2 ? 3 : level === 3 ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-label={['', '', 'High', 'Medium', 'Low'][level]}>
      <rect x="2" y="8" width="2.2" height="4" rx="0.4" fill="currentColor" opacity={bars >= 1 ? 1 : 0.3} />
      <rect x="5.9" y="5" width="2.2" height="7" rx="0.4" fill="currentColor" opacity={bars >= 2 ? 1 : 0.3} />
      <rect x="9.8" y="2" width="2.2" height="10" rx="0.4" fill="currentColor" opacity={bars >= 3 ? 1 : 0.3} />
    </svg>
  );
}

export function IcoStatus({ type, color, size = 14 }: { type: string; color: string; size?: number }) {
  const r = 5.5;
  const cx = 7;
  const cy = 7;
  const circ = 2 * Math.PI * r;
  let dash = 0;
  if (type === 'started') dash = circ * 0.55;
  else if (type === 'completed' || type === 'canceled') dash = circ;

  const dashed = type === 'backlog';
  const filled = type === 'completed' || type === 'canceled';

  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth="1.4"
        strokeDasharray={dashed ? '2 2' : undefined}
        opacity={filled ? 0 : 1} />
      {type === 'started' && (
        <circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth="3"
          strokeDasharray={`${dash} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`}
          fill="none" />
      )}
      {type === 'completed' && (
        <>
          <circle cx={cx} cy={cy} r={r} fill={color} />
          <path d="M4.5 7.2 L6.2 8.9 L9.5 5.5" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}
      {type === 'canceled' && (
        <>
          <circle cx={cx} cy={cy} r={r} fill={color} />
          <path d="M5 5 L9 9 M9 5 L5 9" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </>
      )}
    </svg>
  );
}
