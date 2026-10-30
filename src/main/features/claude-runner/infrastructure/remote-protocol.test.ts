import { describe, expect, it } from 'vitest';

import { buildRemoteProtocolHint, REMOTE_PROTOCOL, REMOTE_SEND_FILE_LINE } from './remote-protocol';

describe('buildRemoteProtocolHint', () => {
  it('is null for a non-remote run, whatever the file capability', () => {
    expect(buildRemoteProtocolHint(false)).toBeNull();
    expect(buildRemoteProtocolHint(false, true)).toBeNull();
  });

  it('is the unchanged pack when the run cannot send files', () => {
    expect(buildRemoteProtocolHint(true)).toBe(REMOTE_PROTOCOL);
    expect(buildRemoteProtocolHint(true, false)).toBe(REMOTE_PROTOCOL);
  });

  it('adds the send-as-file bullet, without mechanics, only when files can be sent', () => {
    const hint = buildRemoteProtocolHint(true, true) as string;
    expect(hint).toBe(`${REMOTE_PROTOCOL}\n${REMOTE_SEND_FILE_LINE}`);
    expect(REMOTE_SEND_FILE_LINE).not.toMatch(/outbox|devia_send_file/);
  });
});
