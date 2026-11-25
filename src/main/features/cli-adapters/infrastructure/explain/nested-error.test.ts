import { describe, it, expect } from 'vitest';
import { extractNestedError, redactSecrets } from './nested-error';

describe('extractNestedError', () => {
  it('reads the provider JSON that PI embeds after "API error (401):"', () => {
    const raw =
      'OpenAI API error (401): {"code":"invalid_api_key","message":"Incorrect API key provided: key_vwqb********MBi2.","param":null,"type":"invalid_request_error"}';
    expect(extractNestedError(raw)).toEqual({
      statusCode: 401,
      code: 'invalid_api_key',
      message: 'Incorrect API key provided: key_vwqb********MBi2.',
      type: 'invalid_request_error',
      provider: 'openai',
    });
  });

  it('reads the { error: {...} } envelope', () => {
    const raw = '{"error":{"message":"The model `x` does not exist","type":"invalid_request_error","code":"model_not_found"}}';
    expect(extractNestedError(raw)).toMatchObject({ code: 'model_not_found', message: 'The model `x` does not exist' });
  });

  it('reads an OpenCode APIError event line', () => {
    const raw = '{"type":"error","name":"APIError","statusCode":401,"message":"Incorrect API key provided"}';
    expect(extractNestedError(raw)).toMatchObject({ statusCode: 401, message: 'Incorrect API key provided' });
  });

  it('reads JSON that is itself encoded inside the message string', () => {
    const inner = JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } });
    const raw = JSON.stringify({ statusCode: 429, message: inner });
    expect(extractNestedError(raw)).toMatchObject({ statusCode: 429, code: 'rate_limit_exceeded', message: 'Slow down' });
  });

  it('takes the status from a "(NNN)" prefix when the JSON has none', () => {
    expect(extractNestedError('Anthropic API error (529): {"message":"Overloaded"}')).toMatchObject({
      statusCode: 529,
      provider: 'anthropic',
    });
  });

  it('returns null for truncated JSON, plain text and empty input — never throws', () => {
    expect(extractNestedError('OpenAI API error (401): {"code":"invalid_api_key","mess')).toBeNull();
    expect(extractNestedError('spawn fake ENOENT')).toBeNull();
    expect(extractNestedError('')).toBeNull();
  });

  it('ignores braces that are not JSON', () => {
    expect(extractNestedError('fatal: {oops} not json')).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('masks an unmasked sk- style key and leaves provider-masked keys alone', () => {
    expect(redactSecrets('bad key sk-proj-abcdefghijklmnop1234 here')).toBe('bad key sk-…[redacted] here');
    expect(redactSecrets('key_vwqb********MBi2')).toBe('key_vwqb********MBi2');
  });

  it('masks bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Authorization: Bearer [redacted]');
  });
});
