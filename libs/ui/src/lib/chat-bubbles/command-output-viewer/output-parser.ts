export type CommandOutputSegment =
  | { readonly kind: 'text'; readonly content: string }
  | {
      readonly kind: 'code';
      readonly fileName: string;
      readonly language: CommandOutputLanguage;
      readonly lines: readonly CommandOutputCodeLine[];
    }
  | {
      readonly kind: 'diff';
      readonly fileName: string;
      readonly lines: readonly CommandOutputDiffLine[];
    }
  | { readonly kind: 'json'; readonly content: string }
  | {
      readonly kind: 'keyValue';
      readonly rows: readonly CommandOutputKeyValue[];
    }
  | {
      readonly kind: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export interface CommandOutputKeyValue {
  readonly key: string;
  readonly value: string;
}

export interface CommandOutputModel {
  readonly raw: string;
  readonly normalized: string;
  readonly segments: readonly CommandOutputSegment[];
}

export type CommandOutputLineTone =
  | 'plain'
  | 'muted'
  | 'success'
  | 'warning'
  | 'error'
  | 'command'
  | 'path';

export interface CommandOutputTextLine {
  readonly text: string;
  readonly tone: CommandOutputLineTone;
}

export type CommandOutputLanguage =
  | 'text'
  | 'ts'
  | 'html'
  | 'scss'
  | 'json'
  | 'md';
export type CommandOutputTokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'tag'
  | 'attr';

export interface CommandOutputCodeLine {
  readonly lineNumber: number;
  readonly tokens: readonly CommandOutputCodeToken[];
}

export interface CommandOutputCodeToken {
  readonly text: string;
  readonly kind: CommandOutputTokenKind;
}

export type CommandOutputDiffLineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta';

export interface CommandOutputDiffLine {
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly marker: string;
  readonly content: string;
  readonly kind: CommandOutputDiffLineKind;
}

export interface ParseCommandOutputOptions {
  readonly command?: string;
}

const ANSI_ESCAPE = String.fromCharCode(27);
const REAL_ANSI_RE = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const BROKEN_ANSI_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)m/g;

export function normalizeTerminalOutput(content: string): string {
  const withoutRealAnsi = content.replace(REAL_ANSI_RE, '');
  const normalizedBreaks = withoutRealAnsi
    .replace(/\r\n/g, '\n')
    .replace(/\r(?!\n)/g, '\n');

  if (!hasBrokenAnsiEvidence(normalizedBreaks)) return normalizedBreaks;
  return normalizedBreaks.replace(BROKEN_ANSI_RE, '');
}

export function parseCommandOutput(
  content: string,
  options: ParseCommandOutputOptions = {},
): CommandOutputModel {
  const normalized = normalizeTerminalOutput(content);
  const diff = parseDiffSegment(normalized, options.command ?? '');
  if (diff) return { raw: content, normalized, segments: [diff] };

  const code = parseCodeSegment(normalized, options.command ?? '');
  if (code) return { raw: content, normalized, segments: [code] };

  const json = parseJsonSegment(normalized);
  if (json) return { raw: content, normalized, segments: [json] };

  return {
    raw: content,
    normalized,
    segments: parseLineSegments(normalized),
  };
}

export function enrichTextLines(
  content: string,
): readonly CommandOutputTextLine[] {
  return content
    .split('\n')
    .map((line) => ({ text: line, tone: classifyOutputLine(line) }));
}

export function classifyOutputLine(line: string): CommandOutputLineTone {
  const trimmed = line.trim();
  if (!trimmed) return 'muted';
  if (/^(error|failed|failure|exception|fatal)\b/i.test(trimmed))
    return 'error';
  if (/^(warning|warn)\b/i.test(trimmed)) return 'warning';
  if (
    /^(success|done|completed|complete)\b/i.test(trimmed) ||
    /^[\u221a\u2713]\s+/.test(trimmed)
  )
    return 'success';
  if (/^>\s+/.test(trimmed)) return 'command';
  if (/^(output location|path|file|directory|cwd):\s+/i.test(trimmed))
    return 'path';
  return 'plain';
}

function hasBrokenAnsiEvidence(content: string): boolean {
  const matches = content.match(BROKEN_ANSI_RE) ?? [];
  if (matches.length >= 2) return true;
  return matches.some((match) => ['[0m', '[22m', '[39m'].includes(match));
}

function parseJsonSegment(content: string): CommandOutputSegment | null {
  const trimmed = content.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0] ?? '')) return null;

  try {
    return {
      kind: 'json',
      content: JSON.stringify(JSON.parse(trimmed), null, 2),
    };
  } catch {
    return null;
  }
}

function parseCodeSegment(
  content: string,
  command: string,
): CommandOutputSegment | null {
  const language = inferLanguage(command, content);
  if (language === 'text') return null;

  const lines = content.split('\n');
  if (lines.length <= 1 && !looksLikeCode(content, language)) return null;

  return {
    kind: 'code',
    fileName: inferFileName(command, language),
    language,
    lines: lines.map((line, index) => ({
      lineNumber: index + 1,
      tokens: tokenizeCodeLine(line, language),
    })),
  };
}

function parseDiffSegment(
  content: string,
  command: string,
): CommandOutputSegment | null {
  const lines = content.split('\n');
  if (!looksLikeDiff(lines)) return null;

  let oldLine = 0;
  let newLine = 0;
  const diffLines: CommandOutputDiffLine[] = [];

  for (const line of lines) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(
      line,
    );
    if (hunk?.[1] && hunk[2]) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      diffLines.push({
        oldLine: null,
        newLine: null,
        marker: '@@',
        content: line,
        kind: 'hunk',
      });
      continue;
    }

    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) {
      diffLines.push({
        oldLine: null,
        newLine: null,
        marker: ' ',
        content: line,
        kind: 'meta',
      });
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      diffLines.push({
        oldLine: null,
        newLine,
        marker: '+',
        content: line.slice(1),
        kind: 'add',
      });
      newLine++;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      diffLines.push({
        oldLine,
        newLine: null,
        marker: '-',
        content: line.slice(1),
        kind: 'del',
      });
      oldLine++;
      continue;
    }

    diffLines.push({
      oldLine: oldLine || null,
      newLine: newLine || null,
      marker: ' ',
      content: line.startsWith(' ') ? line.slice(1) : line,
      kind: 'ctx',
    });
    if (oldLine) oldLine++;
    if (newLine) newLine++;
  }

  return {
    kind: 'diff',
    fileName: inferFileName(command, 'text'),
    lines: diffLines,
  };
}

function parseLineSegments(content: string): CommandOutputSegment[] {
  const lines = content.split('\n');
  const segments: CommandOutputSegment[] = [];
  let pendingText: string[] = [];
  let index = 0;

  const flushText = (): void => {
    const text = trimOuterBlankLines(pendingText).join('\n');
    pendingText = [];
    if (text) segments.push({ kind: 'text', content: text });
  };

  while (index < lines.length) {
    const fixedTable = parseFixedWidthTableAt(lines, index);
    if (fixedTable) {
      flushText();
      segments.push(fixedTable.segment);
      index = fixedTable.nextIndex;
      continue;
    }

    const pipeTable = parsePipeTableAt(lines, index);
    if (pipeTable) {
      flushText();
      segments.push(pipeTable.segment);
      index = pipeTable.nextIndex;
      continue;
    }

    const keyValues = parseKeyValuesAt(lines, index);
    if (keyValues) {
      flushText();
      segments.push(keyValues.segment);
      index = keyValues.nextIndex;
      continue;
    }

    pendingText.push(lines[index] ?? '');
    index++;
  }

  flushText();
  return segments;
}

function parseFixedWidthTableAt(
  lines: readonly string[],
  index: number,
): { segment: CommandOutputSegment; nextIndex: number } | null {
  const headerLine = lines[index] ?? '';
  const separatorLine = lines[index + 1] ?? '';
  const spans = dashedColumnSpans(separatorLine);
  if (spans.length < 2) return null;
  if (!/^(\s*-{2,}\s*){2,}$/.test(separatorLine)) return null;

  const starts = spans.map((span) => span.start);
  const columns = sliceFixedRow(headerLine, starts);
  if (columns.some((column) => column.length === 0)) return null;

  const rows: string[][] = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (line.trim() === '') break;
    if (parsePipeCells(line).length >= 2) break;
    rows.push(sliceFixedRow(line, starts));
    cursor++;
  }

  return rows.length > 0
    ? { segment: { kind: 'table', columns, rows }, nextIndex: cursor }
    : null;
}

function parsePipeTableAt(
  lines: readonly string[],
  index: number,
): { segment: CommandOutputSegment; nextIndex: number } | null {
  const columns = parsePipeCells(lines[index] ?? '');
  if (columns.length < 3) return null;

  const rows: string[][] = [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (line.trim() === '') break;

    const cells = parsePipeCells(line);
    if (cells.length !== columns.length) break;
    if (!isMarkdownSeparatorRow(cells)) rows.push(cells);
    cursor++;
  }

  return rows.length > 0
    ? { segment: { kind: 'table', columns, rows }, nextIndex: cursor }
    : null;
}

function parseKeyValuesAt(
  lines: readonly string[],
  index: number,
): { segment: CommandOutputSegment; nextIndex: number } | null {
  const rows: CommandOutputKeyValue[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    const parsed = parseKeyValue(lines[cursor] ?? '');
    if (!parsed) break;
    rows.push(parsed);
    cursor++;
  }

  return rows.length > 0
    ? { segment: { kind: 'keyValue', rows }, nextIndex: cursor }
    : null;
}

function parseKeyValue(line: string): CommandOutputKeyValue | null {
  const match = /^([A-Za-z][\w ./\\-]{1,48}):\s+(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function looksLikeDiff(lines: readonly string[]): boolean {
  if (lines.some((line) => /^@@\s+-\d/.test(line))) return true;
  const changed = lines.filter(
    (line) => /^[+-]/.test(line) && !/^[+-]{3}\s*$/.test(line),
  );
  return (
    changed.length >= 2 &&
    lines.some((line) => /^(diff --git|--- |\+\+\+ )/.test(line))
  );
}

function inferLanguage(
  command: string,
  content: string,
): CommandOutputLanguage {
  const fileName = inferFileName(command, 'text').toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(fileName)) return 'ts';
  if (fileName.endsWith('.html')) return 'html';
  if (/\.(scss|css)$/.test(fileName)) return 'scss';
  if (fileName.endsWith('.json')) return 'json';
  if (fileName.endsWith('.md')) return 'md';

  const trimmed = content.trim();
  if (
    /^import\s.+from\s+['"]/.test(trimmed) ||
    /@Component\s*\(/.test(trimmed) ||
    /\bexport\s+(class|const|interface|type)\b/.test(trimmed)
  )
    return 'ts';
  if (/^<[\w-]+[\s>]/.test(trimmed) || /<\/[\w-]+>/.test(trimmed))
    return 'html';
  if (/^[.#]?[\w-]+\s*\{[\s\S]*\}/.test(trimmed) && /:\s*[^;]+;/.test(trimmed))
    return 'scss';
  return 'text';
}

function inferFileName(
  command: string,
  fallbackLanguage: CommandOutputLanguage,
): string {
  const match =
    /(?:Get-Content|Read|cat|type)\s+(?:-Raw\s+)?["']?([^"'\s;]+)["']?/i.exec(
      command,
    );
  const value = match?.[1] ?? '';
  if (value) return value.split(/[\\/]/).pop() ?? value;
  return fallbackLanguage === 'text' ? 'output' : fallbackLanguage;
}

function looksLikeCode(
  content: string,
  language: CommandOutputLanguage,
): boolean {
  if (language === 'json' || language === 'md') return true;
  return /[{};<>]/.test(content);
}

function tokenizeCodeLine(
  line: string,
  language: CommandOutputLanguage,
): CommandOutputCodeToken[] {
  if (!line) return [{ text: ' ', kind: 'plain' }];
  if (language === 'html')
    return tokenizeByPattern(
      line,
      /<\/?[\w-]+|[\w:-]+(?==)|"[^"]*"|'[^']*'|<!--.*?-->/g,
      htmlTokenKind,
    );
  if (language === 'scss')
    return tokenizeByPattern(
      line,
      /\/\*.*?\*\/|\/\/.*$|#[\da-f]{3,8}\b|--?[\w-]+(?=\s*:)|[\w-]+(?=\s*:)|-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b|"[^"]*"|'[^']*'/gi,
      scssTokenKind,
    );
  if (language === 'json')
    return tokenizeByPattern(
      line,
      /"[^"]*"(?=\s*:)|"[^"]*"|-?\d+(?:\.\d+)?\b|\b(?:true|false|null)\b/g,
      jsonTokenKind,
    );
  if (language === 'md')
    return tokenizeByPattern(
      line,
      /`[^`]*`|^#{1,6}\s.+|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/g,
      mdTokenKind,
    );
  return tokenizeByPattern(
    line,
    /\/\/.*$|\/\*.*?\*\/|"[^"]*"|'[^']*'|`[^`]*`|\b(?:import|from|export|const|let|var|class|interface|type|readonly|function|return|if|else|for|while|switch|case|new|async|await|private|public|protected|extends|implements)\b|-?\d+(?:\.\d+)?\b/g,
    tsTokenKind,
  );
}

function tokenizeByPattern(
  line: string,
  pattern: RegExp,
  classify: (value: string) => CommandOutputTokenKind,
): CommandOutputCodeToken[] {
  const tokens: CommandOutputCodeToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor)
      tokens.push({ text: line.slice(cursor, match.index), kind: 'plain' });
    tokens.push({ text: match[0], kind: classify(match[0]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length)
    tokens.push({ text: line.slice(cursor), kind: 'plain' });
  return tokens.length > 0 ? tokens : [{ text: line, kind: 'plain' }];
}

function tsTokenKind(value: string): CommandOutputTokenKind {
  if (/^(\/\/|\/\*)/.test(value)) return 'comment';
  if (/^["'`]/.test(value)) return 'string';
  if (/^-?\d/.test(value)) return 'number';
  return 'keyword';
}

function htmlTokenKind(value: string): CommandOutputTokenKind {
  if (value.startsWith('<!--')) return 'comment';
  if (value.startsWith('"') || value.startsWith("'")) return 'string';
  if (value.startsWith('<')) return 'tag';
  return 'attr';
}

function scssTokenKind(value: string): CommandOutputTokenKind {
  if (/^(\/\/|\/\*)/.test(value)) return 'comment';
  if (value.startsWith('"') || value.startsWith("'")) return 'string';
  if (/^-?\d|^#/.test(value)) return 'number';
  return value.startsWith('--') ? 'attr' : 'keyword';
}

function jsonTokenKind(value: string): CommandOutputTokenKind {
  if (/^"[^"]*"(?=\s*:)/.test(value)) return 'attr';
  if (value.startsWith('"')) return 'string';
  if (/^-?\d/.test(value)) return 'number';
  return 'keyword';
}

function mdTokenKind(value: string): CommandOutputTokenKind {
  if (value.startsWith('`')) return 'string';
  if (value.startsWith('#')) return 'tag';
  return 'keyword';
}

function dashedColumnSpans(
  separatorLine: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /-{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(separatorLine)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function sliceFixedRow(line: string, starts: readonly number[]): string[] {
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? line.length;
    return line.slice(start, end).trim();
  });
}

function parsePipeCells(line: string): string[] {
  if (!line.includes('|')) return [];
  const trimmedLine = line.trim();
  const cells = line.split('|').map((cell) => cell.trim());
  return cells.filter((cell, index) => {
    if (index === 0 && cell.length === 0 && trimmedLine.startsWith('|'))
      return false;
    if (
      index === cells.length - 1 &&
      cell.length === 0 &&
      trimmedLine.endsWith('|')
    )
      return false;
    return true;
  });
}

function isMarkdownSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function trimOuterBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
}
