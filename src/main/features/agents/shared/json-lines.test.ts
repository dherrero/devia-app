import { describe, expect, it } from 'vitest';
import { createJsonLineStream } from './json-lines';

function collect(): { messages: unknown[]; stream: ReturnType<typeof createJsonLineStream> } {
  const messages: unknown[] = [];
  return { messages, stream: createJsonLineStream((m) => messages.push(m)) };
}

describe('createJsonLineStream', () => {
  it('emits one message per complete line', () => {
    const { messages, stream } = collect();
    stream.feed('{"a":1}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reassembles a line split across chunks', () => {
    const { messages, stream } = collect();
    stream.feed('{"a":');
    stream.feed('1}\n');
    expect(messages).toEqual([{ a: 1 }]);
  });

  it('tolerates a pretty-printed startup frame', () => {
    const { messages, stream } = collect();
    stream.feed('{\n  "a": 1\n}\n{"b":2}\n');
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores an invalid line', () => {
    const { messages, stream } = collect();
    stream.feed('not json\n{"a":1}\n');
    expect(messages).toEqual([{ a: 1 }]);
  });

  it('flushes a trailing message without newline', () => {
    const { messages, stream } = collect();
    stream.feed('{"a":1}');
    expect(messages).toEqual([]);
    stream.flush();
    expect(messages).toEqual([{ a: 1 }]);
  });
});
