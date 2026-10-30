/**
 * REV-TS-CLI-04-02 — `childPathPrepend` PATH Case Sensitivity on Windows
 *
 * Unit tests for the `findPathKey` and `prependToPath` helpers that fix the
 * PATH case-sensitivity issue on Windows.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { findPathKey, prependToPath } from './spawn-env';

describe('findPathKey', () => {
  it('finds PATH when stored as uppercase PATH (Unix default)', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/usr/local/bin' };
    expect(findPathKey(env)).toBe('PATH');
  });

  it('finds Path when stored as mixed-case Path (Windows PowerShell)', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32' };
    expect(findPathKey(env)).toBe('Path');
  });

  it('finds path when stored as lowercase path', () => {
    const env: NodeJS.ProcessEnv = { path: '/usr/bin' };
    expect(findPathKey(env)).toBe('path');
  });

  it('falls back to PATH when no PATH-equivalent key is found', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' };
    expect(findPathKey(env)).toBe('PATH');
  });

  it('falls back to PATH for empty env', () => {
    expect(findPathKey({})).toBe('PATH');
  });
});

describe('prependToPath', () => {
  it('prepends dirs to PATH when stored as uppercase PATH (Unix)', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prependToPath(env, ['/native/dir']);
    expect(env['PATH']).toBe(`/native/dir${path.delimiter}/usr/bin`);
    expect(env['Path']).toBeUndefined();
  });

  it('prepends dirs to Path when stored as mixed-case Path (Windows)', () => {
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32' };
    prependToPath(env, ['C:\\NativeDir']);
    expect(env['Path']).toBe(`C:\\NativeDir${path.delimiter}C:\\Windows\\System32`);
    // Must NOT create a separate 'PATH' key
    expect(Object.prototype.hasOwnProperty.call(env, 'PATH')).toBe(false);
  });

  it('preserves all existing PATH entries after prepending', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/usr/local/bin' };
    prependToPath(env, ['/native']);
    expect(env['PATH']).toBe(`/native${path.delimiter}/usr/bin:/usr/local/bin`);
  });

  it('creates a PATH key when env has no PATH-equivalent', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/user' };
    prependToPath(env, ['/native']);
    expect(env['PATH']).toBe('/native');
  });

  it('returns env unchanged when dirs is empty', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prependToPath(env, []);
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('handles multiple prepend dirs in order', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prependToPath(env, ['/first', '/second']);
    expect(env['PATH']).toBe(`/first${path.delimiter}/second${path.delimiter}/usr/bin`);
  });
});
