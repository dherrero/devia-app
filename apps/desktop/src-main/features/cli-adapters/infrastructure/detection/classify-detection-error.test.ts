import { describe, it, expect } from 'vitest';
import { classifyDetectionError } from './classify-detection-error';

function makeErrno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('classifyDetectionError', () => {
  it('AC1: ENOENT → "Binary not found on PATH."', () => {
    const err = makeErrno('ENOENT', 'spawn ENOENT C:\\Users\\ruben\\AppData\\Roaming\\npm\\codex.cmd');
    const { label, rawForLog } = classifyDetectionError(err);
    expect(label).toBe('Binary not found on PATH.');
    expect(rawForLog).toContain('codex.cmd');
  });

  it('rawForLog contains the original message (debug parity)', () => {
    const err = makeErrno('ENOENT', 'spawn ENOENT /usr/local/bin/opencode');
    const { rawForLog } = classifyDetectionError(err);
    expect(rawForLog).toBe(err.message);
  });

  it('EACCES → "Binary is not executable."', () => {
    const err = makeErrno('EACCES', 'spawn EACCES /usr/local/bin/gemini');
    expect(classifyDetectionError(err).label).toBe('Binary is not executable.');
  });

  it('AC2: ETIMEDOUT → "Detection probe timed out."', () => {
    const err = makeErrno('ETIMEDOUT', 'connect ETIMEDOUT 127.0.0.1:11434');
    expect(classifyDetectionError(err).label).toBe('Detection probe timed out.');
  });

  it('ESPAWN → "Detection probe timed out."', () => {
    const err = makeErrno('ESPAWN', 'spawn error');
    expect(classifyDetectionError(err).label).toBe('Detection probe timed out.');
  });

  it('message containing "timed out" → "Detection probe timed out."', () => {
    const err = new Error('Process timed out after 3000 ms');
    expect(classifyDetectionError(err).label).toBe('Detection probe timed out.');
  });

  it('AC3: unclassified error → "Detection failed."', () => {
    const err = makeErrno('EUNKNOWN', 'something unexpected');
    expect(classifyDetectionError(err).label).toBe('Detection failed.');
  });

  it('non-Error value → "Detection failed."', () => {
    expect(classifyDetectionError('string error').label).toBe('Detection failed.');
    expect(classifyDetectionError(null).label).toBe('Detection failed.');
    expect(classifyDetectionError(42).label).toBe('Detection failed.');
  });

  it('rawForLog for non-Error is a string representation', () => {
    const { rawForLog } = classifyDetectionError('oops');
    expect(rawForLog).toBe('oops');
  });
});
