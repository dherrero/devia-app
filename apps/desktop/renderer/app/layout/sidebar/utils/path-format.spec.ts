import { describe, it, expect } from 'vitest';
import {
  formatSessionDate,
  leafOf,
  projectSubline,
} from './path-format';

describe('leafOf', () => {
  it('returns the last segment of a normal path', () => {
    expect(leafOf('/ws/repo/sub/leaf')).toBe('leaf');
  });

  it('returns the input when there is no separator', () => {
    expect(leafOf('only-folder')).toBe('only-folder');
  });

  it('handles trailing slashes gracefully', () => {
    expect(leafOf('a/b/c/')).toBe('');
  });
});

describe('projectSubline', () => {
  it('renders nothing when both branch and msgs are empty', () => {
    expect(projectSubline({})).toBe('');
  });

  it('renders branch alone when there are no messages', () => {
    expect(projectSubline({ branch: 'main' })).toBe('main');
  });

  it('appends ● to the branch when dirty', () => {
    expect(projectSubline({ branch: 'main', dirty: true })).toBe('main ●');
  });

  it('joins branch and msgs with a middle dot', () => {
    expect(projectSubline({ branch: 'feat/x', msgs: 12 })).toBe('feat/x · 12 msgs');
  });

  it('skips msgs when count is zero', () => {
    expect(projectSubline({ branch: 'main', msgs: 0 })).toBe('main');
  });
});

describe('formatSessionDate', () => {
  it('renders an empty string when ts is falsy', () => {
    expect(formatSessionDate(0, 'es')).toBe('');
  });

  it('uses the day · time layout when in the same year', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    const sameYear = new Date('2026-03-15T14:30:00Z').getTime();
    expect(formatSessionDate(sameYear, 'es', now)).toMatch(/^15 \w+ · \d{2}:\d{2}$/);
  });

  it('drops the time and prints the year for older entries', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    const oldYear = new Date('2024-10-23T14:30:00Z').getTime();
    const output = formatSessionDate(oldYear, 'es', now);
    expect(output).toMatch(/^23 \w+ 2024$/);
  });
});
