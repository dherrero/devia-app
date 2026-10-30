import { describe, it, expect } from 'vitest';
import { scanScssForViolations } from './check-scss-tokens';

describe('check-scss-tokens (HT-QA-03)', () => {
  describe('px violations', () => {
    it('flags raw px in spacing properties', () => {
      const v = scanScssForViolations('a.scss', '.a { padding: 12px 16px; }');
      expect(v.find((x) => x.rule === 'no-raw-px')).toBeDefined();
    });

    it('allows px on border / outline / box-shadow / border-radius', () => {
      const src = `
        .a {
          border: 1px solid red;
          outline: 2px solid var(--dv-accent);
          box-shadow: 0 1px 2px rgba(0,0,0,.1);
          border-radius: 7px;
        }
      `;
      expect(scanScssForViolations('a.scss', src).filter((x) => x.rule === 'no-raw-px')).toEqual([]);
    });

    it('allows 0.5px hairlines (border-style ambient values)', () => {
      const src = `.a { border-bottom: 0.5px solid var(--dv-divider); }`;
      expect(scanScssForViolations('a.scss', src).filter((x) => x.rule === 'no-raw-px')).toEqual([]);
    });

    it('flags raw px inside transitions (catches sneaky text-shadow/width)', () => {
      const v = scanScssForViolations('a.scss', '.a { width: 320px; }');
      expect(v.find((x) => x.rule === 'no-raw-px')).toBeDefined();
    });

    it('allows px when the line carries a // comment justifying it', () => {
      const src = `.a { width: 22px; /* spec-locked */ }`;
      expect(scanScssForViolations('a.scss', src).filter((x) => x.rule === 'no-raw-px')).toEqual([]);
    });
  });

  describe('hex violations', () => {
    it('flags 3-digit hex colours outside palette files', () => {
      const v = scanScssForViolations('a.scss', '.a { color: #f60; }');
      expect(v.find((x) => x.rule === 'no-raw-hex')).toBeDefined();
    });

    it('flags 6-digit hex colours outside palette files', () => {
      const v = scanScssForViolations('a.scss', '.a { background: #ff6600; }');
      expect(v.find((x) => x.rule === 'no-raw-hex')).toBeDefined();
    });

    it('exempts the master palette file (styles.scss)', () => {
      const v = scanScssForViolations(
        'apps/desktop/renderer/styles.scss',
        '.a { color: #ff6600; }',
      );
      expect(v.filter((x) => x.rule === 'no-raw-hex')).toEqual([]);
    });

    it('allows hex in url() (sprite hashes, SVG IDs)', () => {
      const src = `.a { background: url('icon-#abcdef.svg'); }`;
      expect(scanScssForViolations('a.scss', src).filter((x) => x.rule === 'no-raw-hex')).toEqual([]);
    });
  });
});
