import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsGrokSessionsReader } from './fs-grok-sessions-reader';
import { parseGrokTranscript } from '../../../../shared/domain/grok-transcript';

// node:sqlite is experimental and may be unavailable on older Node — skip
// gracefully rather than failing the suite where the reader degrades anyway.
let sqlite: { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown }; close(): void } } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

const SID = 'sess123456789';
const CWD = '/ws/Eviatech/devia';

describe.skipIf(!sqlite)('FsGrokSessionsReader (S-21 T-228)', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-db-'));
    prevHome = process.env['GROK_HOME'];
    process.env['GROK_HOME'] = dir;

    const db = new sqlite!.DatabaseSync(path.join(dir, 'grok.db'));
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, mode TEXT,
        cwd_at_start TEXT NOT NULL, cwd_last TEXT NOT NULL, status TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
        message_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, seq));
    `);
    db.prepare('INSERT INTO sessions (id,title,model,mode,cwd_at_start,cwd_last,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(SID, 'My session', 'grok-4.3', 'agent', CWD, CWD, 'done', '2026-06-20T10:00:00.000Z', '2026-06-20T10:05:00.000Z');
    db.prepare('INSERT INTO messages (session_id,seq,role,message_json,created_at) VALUES (?,?,?,?,?)')
      .run(SID, 0, 'user', JSON.stringify({ role: 'user', content: 'hola grok' }), '2026-06-20T10:00:00.000Z');
    db.prepare('INSERT INTO messages (session_id,seq,role,message_json,created_at) VALUES (?,?,?,?,?)')
      .run(SID, 1, 'assistant', JSON.stringify({ role: 'assistant', content: 'hey' }), '2026-06-20T10:00:01.000Z');
    db.close();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['GROK_HOME']; else process.env['GROK_HOME'] = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is available and lists sessions by id', () => {
    const reader = new FsGrokSessionsReader();
    expect(reader.available()).toBe(true);
    const refs = reader.listTranscripts();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nativeId: SID, filePath: SID });
  });

  it('read() serialises a session the pure parser can consume', () => {
    const reader = new FsGrokSessionsReader();
    const text = reader.read(SID)!;
    expect(text).not.toBeNull();
    const parsed = parseGrokTranscript(text)!;
    expect(parsed).toMatchObject({ agentId: 'grok', agentSessionId: SID, cwd: CWD, resumable: true, title: 'My session' });
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('read() returns null for an unknown session id', () => {
    expect(new FsGrokSessionsReader().read('nope')).toBeNull();
  });
});
