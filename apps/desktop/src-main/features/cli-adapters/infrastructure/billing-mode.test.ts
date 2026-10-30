import { describe, it, expect } from 'vitest';
import { deriveBillingMode } from './billing-mode';

describe('deriveBillingMode', () => {
  it('claude + ANTHROPIC_API_KEY set → api', () => {
    expect(deriveBillingMode('claude', { ANTHROPIC_API_KEY: 'sk-ant-xxx' }, undefined)).toBe('api');
  });

  it('claude + ANTHROPIC_BASE_URL set (no API key) → api', () => {
    expect(deriveBillingMode('claude', { ANTHROPIC_BASE_URL: 'http://localhost:1234' }, undefined)).toBe('api');
  });

  it('claude + empty string for key → not api (falls through)', () => {
    expect(deriveBillingMode('claude', { ANTHROPIC_API_KEY: '' }, { kind: 'logged-in' })).toBe('subscription');
  });

  it('claude + whitespace-only for key → not api (falls through)', () => {
    expect(deriveBillingMode('claude', { ANTHROPIC_API_KEY: '   ' }, { kind: 'logged-out' })).toBe('unknown');
  });

  it('claude + no env + authStatus logged-in → subscription', () => {
    expect(deriveBillingMode('claude', undefined, { kind: 'logged-in' })).toBe('subscription');
  });

  it('claude + no env + authStatus logged-out → unknown', () => {
    expect(deriveBillingMode('claude', undefined, { kind: 'logged-out' })).toBe('unknown');
  });

  it('claude + no env + authStatus undefined → unknown', () => {
    expect(deriveBillingMode('claude', undefined, undefined)).toBe('unknown');
  });

  it('codex + OPENAI_API_KEY → api', () => {
    expect(deriveBillingMode('codex', { OPENAI_API_KEY: 'sk-openai-xxx' }, undefined)).toBe('api');
  });

  it('gemini + GEMINI_API_KEY → api', () => {
    expect(deriveBillingMode('gemini', { GEMINI_API_KEY: 'AIza-xxx' }, undefined)).toBe('api');
  });

  it('gemini + GOOGLE_API_KEY → api', () => {
    expect(deriveBillingMode('gemini', { GOOGLE_API_KEY: 'AIza-yyy' }, undefined)).toBe('api');
  });

  it('qwen + DASHSCOPE_API_KEY → api', () => {
    expect(deriveBillingMode('qwen', { DASHSCOPE_API_KEY: 'sk-qwen-xxx' }, undefined)).toBe('api');
  });

  it('copilot + any env keys → not api (no API keys configured for copilot)', () => {
    const result = deriveBillingMode('copilot', { ANTHROPIC_API_KEY: 'sk-xxx' }, { kind: 'logged-in' });
    expect(result === 'subscription' || result === 'unknown').toBe(true);
  });

  it('copilot + logged-in → subscription', () => {
    expect(deriveBillingMode('copilot', {}, { kind: 'logged-in' })).toBe('subscription');
  });

  it('copilot + logged-out → unknown', () => {
    expect(deriveBillingMode('copilot', {}, { kind: 'logged-out' })).toBe('unknown');
  });

  it('unknown agent id + logged-in → subscription', () => {
    expect(deriveBillingMode('unknown-agent', undefined, { kind: 'logged-in' })).toBe('subscription');
  });

  it('unknown agent id + no env + no auth → unknown', () => {
    expect(deriveBillingMode('unknown-agent', undefined, undefined)).toBe('unknown');
  });

  it('deepseek + DEEPSEEK_API_KEY → api', () => {
    expect(deriveBillingMode('deepseek', { DEEPSEEK_API_KEY: 'sk-deepseek-xxx' }, undefined)).toBe('api');
  });
});
