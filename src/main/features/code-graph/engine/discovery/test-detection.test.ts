import { describe, expect, it } from 'vitest';
import { isTestFile } from './test-detection';

describe('isTestFile', () => {
  it('detects go and dart conventions', () => {
    expect(isTestFile('foo_test.go', 'go')).toBe(true);
    expect(isTestFile('foo.go', 'go')).toBe(false);
    expect(isTestFile('test/widget_test.dart', 'dart')).toBe(true);
    expect(isTestFile('test/helper.dart', 'dart')).toBe(true);
    expect(isTestFile('lib/widget.dart', 'dart')).toBe(false);
  });

  it('detects typescript and javascript conventions', () => {
    expect(isTestFile('src/a.spec.ts', 'typescript')).toBe(true);
    expect(isTestFile('src/a.test.tsx', 'typescript')).toBe(true);
    expect(isTestFile('src/__tests__/a.ts', 'typescript')).toBe(true);
    expect(isTestFile('src/a.test.js', 'javascript')).toBe(true);
    expect(isTestFile('src/a.ts', 'typescript')).toBe(false);
    expect(isTestFile('src/contest.ts', 'typescript')).toBe(false);
  });

  it('detects python conventions', () => {
    expect(isTestFile('test_a.py', 'python')).toBe(true);
    expect(isTestFile('pkg/a_test.py', 'python')).toBe(true);
    expect(isTestFile('tests/conftest.py', 'python')).toBe(true);
    expect(isTestFile('pkg/a.py', 'python')).toBe(false);
  });

  it('detects java conventions', () => {
    expect(isTestFile('src/main/java/FooTest.java', 'java')).toBe(true);
    expect(isTestFile('FooTests.java', 'java')).toBe(true);
    expect(isTestFile('src/test/java/Helper.java', 'java')).toBe(true);
    expect(isTestFile('src/main/java/Foo.java', 'java')).toBe(false);
  });

  it('normalises windows separators', () => {
    expect(isTestFile('src\\test\\java\\Helper.java', 'java')).toBe(true);
  });
});
