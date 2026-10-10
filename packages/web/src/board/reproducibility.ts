import type { BugReproducibility } from './types';

/**
 * How often a bug shows up when someone tries (INV-1122). A SOMETIMES or ONCE
 * bug is never auto-accepted: green CI cannot prove an intermittent bug gone.
 */
export const REPRODUCIBILITY_OPTIONS: ReadonlyArray<{ value: BugReproducibility; label: string; description: string }> = [
  { value: 'ALWAYS', label: 'Always', description: 'Every try shows it.' },
  { value: 'SOMETIMES', label: 'Sometimes', description: 'Some tries show it. A person accepts the fix; it is never auto-accepted.' },
  { value: 'ONCE', label: 'Once', description: 'Seen once, not reproduced since. A person accepts the fix; it is never auto-accepted.' },
];
