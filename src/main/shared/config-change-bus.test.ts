import { describe, expect, it, vi } from 'vitest';
import type { DeviaConfig } from '../../shared/domain/config';
import { ConfigChangeBus } from './config-change-bus';

const cfg = { agentId: 'claude' } as unknown as DeviaConfig;

describe('ConfigChangeBus', () => {
  it('publish calls every subscriber with the new config', () => {
    const bus = new ConfigChangeBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.publish(cfg);
    expect(a).toHaveBeenCalledWith(cfg);
    expect(b).toHaveBeenCalledWith(cfg);
  });

  it('the returned function unsubscribes', () => {
    const bus = new ConfigChangeBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    off();
    bus.publish(cfg);
    expect(a).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not stop the others', () => {
    const bus = new ConfigChangeBus();
    const b = vi.fn();
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe(b);
    expect(() => bus.publish(cfg)).not.toThrow();
    expect(b).toHaveBeenCalledWith(cfg);
  });
});
