import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DvCommandOutputViewerComponent } from './component';
import { normalizeTerminalOutput, parseCommandOutput } from './output-parser';

describe('command output parser', () => {
  it('removes real and visible ANSI styling codes', () => {
    expect(normalizeTerminalOutput('\x1b[32m√\x1b[39m Building...')).toBe(
      '√ Building...',
    );
    expect(
      normalizeTerminalOutput('[33m>[39m Building...\n[32m√[39m Building...'),
    ).toBe('> Building...\n√ Building...');
  });

  it('does not remove ordinary bracketed text without ANSI evidence', () => {
    expect(normalizeTerminalOutput('version [32m] is documented')).toBe(
      'version [32m] is documented',
    );
  });

  it('parses PowerShell fixed-width table output', () => {
    const model = parseCommandOutput(`
Name               Mode   Length
----               ----   ------
.angular           d-----
package-lock.json  -a---- 295222
AGENTS.md          -a---- 2793
`);

    expect(model.segments).toEqual([
      {
        kind: 'table',
        columns: ['Name', 'Mode', 'Length'],
        rows: [
          ['.angular', 'd-----', ''],
          ['package-lock.json', '-a----', '295222'],
          ['AGENTS.md', '-a----', '2793'],
        ],
      },
    ]);
  });

  it('parses Angular build pipe-style chunk tables after ANSI cleanup', () => {
    const model = parseCommandOutput(`
[1mInitial chunk files[22m[2m | [22m[1mNames[22m        [2m | [22m [1mRaw size[22m[2m | [22m[1mEstimated transfer size[22m
[32mchunk-NJAKQBJP.js[39m  [2m | [22m[2m-[22m            [2m | [22m[36m224.79 kB[39m[2m | [22m               [36m62.36 kB[39m
[32mmain-FAKSNF6Z.js[39m   [2m | [22m[2mmain[22m         [2m | [22m[36m611 bytes[39m[2m | [22m              [36m611 bytes[39m
`);

    expect(model.segments).toEqual([
      {
        kind: 'table',
        columns: [
          'Initial chunk files',
          'Names',
          'Raw size',
          'Estimated transfer size',
        ],
        rows: [
          ['chunk-NJAKQBJP.js', '-', '224.79 kB', '62.36 kB'],
          ['main-FAKSNF6Z.js', 'main', '611 bytes', '611 bytes'],
        ],
      },
    ]);
  });

  it('formats valid JSON output', () => {
    expect(parseCommandOutput('{"ok":true,"count":2}').segments).toEqual([
      { kind: 'json', content: '{\n  "ok": true,\n  "count": 2\n}' },
    ]);
  });

  it('renders file reads as code when the command exposes a known extension', () => {
    const model = parseCommandOutput(
      "import { Component } from '@angular/core';\nexport class App {}",
      {
        command: 'Get-Content -Raw src\\app\\app.ts',
      },
    );

    expect(model.segments[0]).toMatchObject({
      kind: 'code',
      fileName: 'app.ts',
      language: 'ts',
    });
  });

  it('parses unified diff output', () => {
    const model = parseCommandOutput(
      'diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new',
    );

    expect(model.segments[0]).toMatchObject({
      kind: 'diff',
      lines: [
        { kind: 'meta' },
        { kind: 'hunk' },
        { kind: 'del', marker: '-', content: 'old' },
        { kind: 'add', marker: '+', content: 'new' },
      ],
    });
  });

  it('keeps unknown output as text', () => {
    expect(parseCommandOutput('line one\nline two').segments).toEqual([
      { kind: 'text', content: 'line one\nline two' },
    ]);
  });
});

describe('DvCommandOutputViewerComponent', () => {
  let fixture: ComponentFixture<DvCommandOutputViewerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DvCommandOutputViewerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DvCommandOutputViewerComponent);
    fixture.componentRef.setInput(
      'content',
      'Name  Mode\n----  ----\na.ts  -a---',
    );
    fixture.detectChanges();
  });

  it('renders enriched tables by default', () => {
    expect(fixture.nativeElement.querySelector('table')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Name');
    expect(fixture.nativeElement.textContent).toContain('a.ts');
  });

  it('can switch to raw output', () => {
    const button = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ).find(
      (el) => (el as HTMLButtonElement).textContent?.trim() === 'Raw',
    ) as HTMLButtonElement;

    button.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('table')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('pre')?.textContent).toContain(
      'Name  Mode',
    );
  });

  it('renders code output with an IDE-style gutter', () => {
    fixture.componentRef.setInput(
      'command',
      'Get-Content -Raw src\\app\\app.ts',
    );
    fixture.componentRef.setInput(
      'content',
      "import { Component } from '@angular/core';\nexport class App {}",
    );
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.dv-command-output__code'),
    ).toBeTruthy();
    expect(
      fixture.nativeElement
        .querySelector('.dv-command-output__ln')
        ?.textContent?.trim(),
    ).toBe('1');
    expect(fixture.nativeElement.textContent).toContain('app.ts');
  });

  it('renders diff output with add and delete rows', () => {
    fixture.componentRef.setInput(
      'content',
      'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new',
    );
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-kind="del"]'),
    ).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector('[data-kind="add"]'),
    ).toBeTruthy();
  });
});
