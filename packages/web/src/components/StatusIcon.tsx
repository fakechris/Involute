type StatusKind = 'backlog' | 'unstarted' | 'started' | 'review' | 'completed' | 'canceled';

export function getStatusKind(stateName: string): StatusKind {
  const normalized = stateName.toLowerCase();

  if (normalized.includes('backlog')) {
    return 'backlog';
  }
  if (normalized.includes('cancel')) {
    return 'canceled';
  }
  if (normalized.includes('done') || normalized.includes('complete') || normalized.includes('closed')) {
    return 'completed';
  }
  if (normalized.includes('review')) {
    return 'review';
  }
  if (normalized.includes('progress') || normalized.includes('start') || normalized.includes('doing')) {
    return 'started';
  }

  return 'unstarted';
}

function getStatusColorVar(kind: StatusKind): string {
  switch (kind) {
    case 'completed':
      return 'var(--success)';
    case 'canceled':
      return 'var(--fg-dim)';
    case 'started':
      return 'var(--warn)';
    case 'review':
      return 'var(--info)';
    default:
      return 'var(--fg-dim)';
  }
}

interface StatusIconProps {
  stateName: string;
  size?: number;
}

export function StatusIcon({ stateName, size = 14 }: StatusIconProps) {
  const kind = getStatusKind(stateName);
  const color = getStatusColorVar(kind);
  const radius = 5.5;
  const center = 7;
  const circumference = 2 * Math.PI * radius;
  const partialDash = kind === 'review' ? circumference * 0.8 : circumference * 0.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      role="img"
      aria-label={`Status: ${stateName}`}
      style={{ flexShrink: 0 }}
    >
      {kind === 'backlog' ? (
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke={color}
          strokeWidth="1.4"
          strokeDasharray="2 2"
        />
      ) : null}

      {kind === 'unstarted' ? (
        <circle cx={center} cy={center} r={radius} stroke={color} strokeWidth="1.4" />
      ) : null}

      {kind === 'started' || kind === 'review' ? (
        <>
          <circle cx={center} cy={center} r={radius} stroke={color} strokeWidth="1.4" opacity="0.4" />
          <circle
            cx={center}
            cy={center}
            r={radius}
            stroke={color}
            strokeWidth="2.6"
            strokeDasharray={`${partialDash} ${circumference}`}
            transform={`rotate(-90 ${center} ${center})`}
            strokeLinecap="butt"
          />
        </>
      ) : null}

      {kind === 'completed' ? (
        <>
          <circle cx={center} cy={center} r={radius} fill={color} />
          <path
            d="M4.5 7.2 L6.2 8.9 L9.5 5.5"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      ) : null}

      {kind === 'canceled' ? (
        <>
          <circle cx={center} cy={center} r={radius} fill={color} />
          <path
            d="M5 5 L9 9 M9 5 L5 9"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </>
      ) : null}
    </svg>
  );
}
