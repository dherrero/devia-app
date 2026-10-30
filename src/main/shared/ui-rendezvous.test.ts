import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UI_TOOL_NAMES } from '../../shared/domain/ui-tools';
import {
  answerFilePath,
  isRequestFileName,
  readUiAnswer,
  readUiRequest,
  removeUiCall,
  requestFilePath,
  safeCallFileName,
  uiRunDir,
  writeJsonAtomic,
  writeLegacyUiAnswer,
  writeUiAnswer,
  writeUiRequest,
  writeUiSignal,
} from './ui-rendezvous';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ui-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('round trip', () => {
  it.each(UI_TOOL_NAMES)('write/read a %s request', (tool) => {
    writeUiRequest(dir, { callId: 'c1', tool, toolInput: { a: 1 } });
    const read = readUiRequest(requestFilePath(dir, 'c1'));
    expect(read).toMatchObject({ callId: 'c1', tool, toolInput: { a: 1 }, expectsAnswer: true });
    expect(typeof read?.ts).toBe('number');
  });

  it('writes an answer and reads it back', () => {
    writeUiAnswer(dir, 'c1', 'la respuesta');
    expect(readUiAnswer(answerFilePath(dir, 'c1'))).toEqual({ answer: 'la respuesta' });
  });

  it('marks a fire-and-forget signal as not expecting an answer', () => {
    writeUiSignal(dir, 'c2', 'todo', { items: [] });
    expect(readUiRequest(requestFilePath(dir, 'c2'))?.expectsAnswer).toBe(false);
  });

  it('creates the directory on demand', () => {
    const nested = path.join(dir, 'a', 'b');
    writeUiRequest(nested, { callId: 'c1', tool: 'todo', toolInput: null });
    expect(fs.existsSync(requestFilePath(nested, 'c1'))).toBe(true);
  });
});

describe('back-compat with S-24', () => {
  it('treats a request with no tool field as a question', () => {
    const file = requestFilePath(dir, 'legacy');
    writeJsonAtomic(file, { toolUseId: 'legacy', toolInput: { questions: [] } });
    const read = readUiRequest(file);
    expect(read?.tool).toBe('ask_user');
    expect(read?.callId).toBe('legacy');
    expect(read?.expectsAnswer).toBe(true);
  });

  it('reads the hook-era answer payload', () => {
    writeLegacyUiAnswer(dir, 'c1', { answers: { q1: 'sí', q2: 'no' } });
    expect(readUiAnswer(answerFilePath(dir, 'c1'))).toEqual({ answer: 'sí\nno' });
  });

  it('returns null for a legacy payload with no answers', () => {
    writeLegacyUiAnswer(dir, 'c1', { nothing: true });
    expect(readUiAnswer(answerFilePath(dir, 'c1'))).toBeNull();
  });
});

describe('defensive reads', () => {
  it('returns null for a missing file', () => {
    expect(readUiRequest(path.join(dir, 'nope.request.json'))).toBeNull();
    expect(readUiAnswer(path.join(dir, 'nope.answer.json'))).toBeNull();
  });

  it('returns null for corrupt or partial JSON', () => {
    const file = requestFilePath(dir, 'bad');
    fs.writeFileSync(file, '{ "callId": "bad", ', 'utf8');
    expect(readUiRequest(file)).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    const file = requestFilePath(dir, 'arr');
    fs.writeFileSync(file, '[1,2,3]', 'utf8');
    expect(readUiRequest(file)).toBeNull();
  });

  it('returns null when the id is missing', () => {
    const file = requestFilePath(dir, 'noid');
    writeJsonAtomic(file, { tool: 'todo', toolInput: {} });
    expect(readUiRequest(file)).toBeNull();
  });
});

describe('path containment', () => {
  it('sanitises separators and traversal out of the call id', () => {
    expect(safeCallFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeCallFileName('a b/c\\d')).toBe('a_b_c_d');
  });

  it('keeps a hostile call id inside the rendezvous directory', () => {
    writeUiRequest(dir, { callId: '../escape', tool: 'todo', toolInput: null });
    const written = fs.readdirSync(dir);
    expect(written).toHaveLength(1);
    expect(path.dirname(requestFilePath(dir, '../escape'))).toBe(dir);
  });

  it('keeps a hostile run id inside the tmp root', () => {
    expect(path.dirname(uiRunDir('../../evil'))).toBe(path.join(os.tmpdir(), 'devia-ui'));
  });
});

describe('housekeeping', () => {
  it('recognises request file names only', () => {
    expect(isRequestFileName('a.request.json')).toBe(true);
    expect(isRequestFileName('a.answer.json')).toBe(false);
  });

  it('removes both files of a call and tolerates a missing one', () => {
    writeUiRequest(dir, { callId: 'c1', tool: 'ask_user', toolInput: null });
    removeUiCall(dir, 'c1');
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(() => removeUiCall(dir, 'c1')).not.toThrow();
  });

  it('never leaves a temp file behind after an atomic write', () => {
    writeUiRequest(dir, { callId: 'c1', tool: 'ask_user', toolInput: null });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
