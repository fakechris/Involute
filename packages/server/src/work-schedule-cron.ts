/**
 * The clock behind a scheduled work item (INV-1582): a five-field cron
 * expression read in the schedule's time zone, with no library — the server
 * only ever asks "when is the next minute this matches, after this instant".
 *
 * Fields: minute hour day-of-month month day-of-week. Each accepts `*`,
 * a number, a list `1,2,3`, a range `1-5` and a step `*\/15` or `1-5/2`;
 * day-of-week 0–7 (0 and 7 are Sunday). Day-of-month and day-of-week are
 * combined with OR when both are restricted, as Vixie cron does.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number> | null;
  month: Set<number>;
  dayOfWeek: Set<number> | null;
}

export const CRON_FORMAT_MESSAGE = 'A schedule is five cron fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5").';
export const CRON_TIMEZONE_MESSAGE = 'The time zone is an IANA name, e.g. Asia/Shanghai or UTC.';

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null;
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(CRON_FORMAT_MESSAGE);
    const [, startText, endText, stepText] = match;
    const step = stepText ? Number(stepText) : 1;
    let start = startText === '*' ? min : Number(startText);
    let end = endText ? Number(endText) : startText === '*' ? max : start;
    if (stepText && !endText && startText !== '*') end = max;
    if (!Number.isInteger(step) || step < 1 || start < min || end > max || start > end) throw new Error(CRON_FORMAT_MESSAGE);
    for (let value = start; value <= end; value += step) values.add(value);
    start = end = 0;
  }
  return values;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(CRON_FORMAT_MESSAGE);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const dow = parseField(dayOfWeek, 0, 7);
  if (dow?.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(minute, 0, 59) ?? new Set(Array.from({ length: 60 }, (_, i) => i)),
    hour: parseField(hour, 0, 23) ?? new Set(Array.from({ length: 24 }, (_, i) => i)),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12) ?? new Set(Array.from({ length: 12 }, (_, i) => i + 1)),
    dayOfWeek: dow,
  };
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(zone, cached);
  }
  return cached;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock fields of an instant in a zone. */
export function wallClock(at: Date, zone: string): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } {
  const parts = Object.fromEntries(formatter(zone).formatToParts(at).map((part) => [part.type, part.value]));
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: WEEKDAYS[parts.weekday as string] ?? 0,
  };
}

export function matches(fields: CronFields, at: Date, zone: string): boolean {
  const clock = wallClock(at, zone);
  if (!fields.minute.has(clock.minute) || !fields.hour.has(clock.hour) || !fields.month.has(clock.month)) return false;
  const domOk = fields.dayOfMonth === null || fields.dayOfMonth.has(clock.dayOfMonth);
  const dowOk = fields.dayOfWeek === null || fields.dayOfWeek.has(clock.dayOfWeek);
  if (fields.dayOfMonth !== null && fields.dayOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * The first matching minute strictly after `after`, within two years; null
 * when none. Steps a minute at a time only inside a matching hour; otherwise
 * it jumps to the start of the next wall-clock hour, so a yearly rule costs
 * thousands of checks, not a million.
 */
export function nextMatch(expression: string, zone: string, after: Date): Date | null {
  const fields = parseCron(expression);
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 2 * 366 * 24 * 60 * 60_000;
  while (t < limit) {
    const at = new Date(t);
    const clock = wallClock(at, zone);
    const domOk = fields.dayOfMonth === null || fields.dayOfMonth.has(clock.dayOfMonth);
    const dowOk = fields.dayOfWeek === null || fields.dayOfWeek.has(clock.dayOfWeek);
    const dayOk = fields.dayOfMonth !== null && fields.dayOfWeek !== null ? domOk || dowOk : domOk && dowOk;
    if (!fields.month.has(clock.month) || !dayOk || !fields.hour.has(clock.hour)) {
      t += (60 - clock.minute) * 60_000;
      continue;
    }
    if (fields.minute.has(clock.minute)) return at;
    t += 60_000;
  }
  return null;
}
