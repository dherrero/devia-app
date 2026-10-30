const LIMIT_TEXT = /hit your [a-z ]*limit/i;
// "resets 11:30am (Europe/Madrid)" and, for windows that reopen on another day,
// "resets Oct 30, 3pm (Europe/Madrid)" / "resets Oct 30 at 3:00pm (...)".
const RESETS =
  /resets\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function isLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

function wallToInstant(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  const at = wall - zoneOffsetMs(timeZone, wall);
  // The offset was sampled at the wall time read as UTC; re-sample at the guess.
  return wall - zoneOffsetMs(timeZone, at);
}

/**
 * Epoch ms of the next occurrence of "resets 11:30am (Europe/Madrid)" (or the
 * dated variant) after `now`, or undefined when the text carries no usable
 * time. Only a fallback: the structured `resetsAt` Claude Code reports wins
 * whenever it is present.
 */
export function parseResetFromText(text: string, now: number): number | undefined {
  const m = RESETS.exec(text);
  if (!m) return undefined;
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === 'pm') hour += 12;
  const minute = Number(m[4] ?? '0');
  const timeZone = m[6]!;
  try {
    const today = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date(now));
    const get = (t: string): number => Number(today.find((p) => p.type === t)?.value);
    const year = get('year');

    if (m[1] !== undefined) {
      const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (month < 0) return undefined;
      const day = Number(m[2]);
      const at = wallToInstant(timeZone, year, month, day, hour, minute);
      // A date already behind us means next year (reset right after New Year).
      return at > now ? at : wallToInstant(timeZone, year + 1, month, day, hour, minute);
    }

    const at = wallToInstant(timeZone, year, get('month') - 1, get('day'), hour, minute);
    return at > now ? at : at + DAY_MS;
  } catch {
    return undefined;
  }
}
