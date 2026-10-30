import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { probeGeminiAuthStatus } from './probe-gemini-auth';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-gemini-auth-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('probeGeminiAuthStatus (S-19 F2.1)', () => {
  it('ok when GEMINI_API_KEY is set', async () => {
    expect(await probeGeminiAuthStatus('gemini', { GEMINI_API_KEY: 'x' })).toEqual({ status: 'ok' });
  });

  it('ok when GOOGLE_API_KEY is set', async () => {
    expect(await probeGeminiAuthStatus('gemini', { GOOGLE_API_KEY: 'y' })).toEqual({ status: 'ok' });
  });

  it('ok when ~/.gemini/oauth_creds.json exists', async () => {
    fs.mkdirSync(path.join(tmp, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.gemini', 'oauth_creds.json'), '{}');
    expect(await probeGeminiAuthStatus('gemini', { HOME: tmp })).toEqual({ status: 'ok' });
  });

  it('missing when home has no key and no creds', async () => {
    const r = await probeGeminiAuthStatus('gemini', { HOME: tmp });
    expect(r.status).toBe('missing');
    expect(r.message).toBeTruthy();
  });

  it('unknown when no key and no home', async () => {
    expect(await probeGeminiAuthStatus('gemini', {})).toEqual({ status: 'unknown' });
  });
});
