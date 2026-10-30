import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { probeOpencodeAuthStatus } from './probe-opencode-auth';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-opencode-auth-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('probeOpencodeAuthStatus (S-19 F2.1)', () => {
  it('ok when a provider API key is set', async () => {
    expect(await probeOpencodeAuthStatus('opencode', { ANTHROPIC_API_KEY: 'x' })).toEqual({ status: 'ok' });
    expect(await probeOpencodeAuthStatus('opencode', { OPENAI_API_KEY: 'x' })).toEqual({ status: 'ok' });
    expect(await probeOpencodeAuthStatus('opencode', { OPENROUTER_API_KEY: 'x' })).toEqual({ status: 'ok' });
  });

  it('ok when $XDG_DATA_HOME/opencode/auth.json exists', async () => {
    fs.mkdirSync(path.join(tmp, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'opencode', 'auth.json'), '{}');
    expect(await probeOpencodeAuthStatus('opencode', { XDG_DATA_HOME: tmp })).toEqual({ status: 'ok' });
  });

  it('ok via the ~/.local/share fallback when HOME has the auth file', async () => {
    fs.mkdirSync(path.join(tmp, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.local', 'share', 'opencode', 'auth.json'), '{}');
    expect(await probeOpencodeAuthStatus('opencode', { HOME: tmp })).toEqual({ status: 'ok' });
  });

  it('missing (or unknown on win32) when no key and no auth file', async () => {
    const r = await probeOpencodeAuthStatus('opencode', { HOME: tmp });
    if (process.platform === 'win32') {
      expect(r.status).toBe('unknown');
    } else {
      expect(r.status).toBe('missing');
      expect(r.message).toBeTruthy();
    }
  });

  it('unknown when no key and no home/data dir', async () => {
    expect(await probeOpencodeAuthStatus('opencode', {})).toEqual({ status: 'unknown' });
  });
});
