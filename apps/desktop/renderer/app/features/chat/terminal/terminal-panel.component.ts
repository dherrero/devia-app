import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy,
  ViewEncapsulation, effect, inject, input, signal, viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { TranslateModule } from '@ngx-translate/core';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { TerminalStreamService } from './services/terminal-stream.service';

// xterm's webgl/canvas renderers don't resolve CSS custom properties, so the
// palette has to be expressed as raw hex. Aligned with Devia's "soft green
// terminal" feel (bg/elev tokens from styles.scss).
const TERMINAL_THEME: ITheme = {
  background: '#0a1410',
  foreground: '#e6f3ea',
  cursor: '#52b788',
  cursorAccent: '#0a1410',
  selectionBackground: 'rgba(82, 183, 136, 0.35)',
  black: '#1a2520',
  red: '#e87a7a',
  green: '#7cb893',
  yellow: '#e8c87a',
  blue: '#7aa8e8',
  magenta: '#c47ae8',
  cyan: '#7ae0e8',
  white: '#e6f3ea',
  brightBlack: '#536b5f',
  brightRed: '#ff9b9b',
  brightGreen: '#9bd4ae',
  brightYellow: '#ffe39b',
  brightBlue: '#9bc6ff',
  brightMagenta: '#dc9bff',
  brightCyan: '#9bf3ff',
  brightWhite: '#ffffff',
};

@Component({
  selector: 'ds-terminal-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [TranslateModule],
  templateUrl: './terminal-panel.component.html',
  styleUrl: './terminal-panel.component.scss',
})
export class TerminalPanelComponent implements AfterViewInit, OnDestroy {
  readonly project = input.required<string>();
  readonly exitCode = signal<number | null>(null);

  protected readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly api = inject(ElectronApiService);
  private readonly stream = inject(TerminalStreamService);

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private currentProject: string | null = null;
  private viewReady = false;
  private subs = new Subscription();

  constructor() {
    // Re-attach whenever the bound project changes. Effect waits for
    // ngAfterViewInit because the host element doesn't exist until then.
    effect(() => {
      const p = this.project();
      if (!this.viewReady) return;
      void this.attachForProject(p);
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    void this.attachForProject(this.project());
  }

  ngOnDestroy(): void {
    this.disposeTerminal();
  }

  /**
   * Public hook for the parent: when the panel becomes visible again after
   * being display:none, xterm may have been measured at 0×0 and stuck at
   * its default 80×24. Re-fit and restore focus so the user can keep typing.
   */
  refitAndFocus(): void {
    if (!this.terminal || !this.fitAddon) return;
    const rect = this.host().nativeElement.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    try { this.fitAddon.fit(); } catch { /* fit throws on detached nodes */ }
    this.terminal.focus();
  }

  private async attachForProject(project: string): Promise<void> {
    if (this.currentProject === project && this.terminal) return;
    this.disposeTerminal();
    this.currentProject = project;
    this.exitCode.set(null);

    const hostEl = this.host().nativeElement;
    // Wait one frame so the host has a non-zero bounding box; otherwise
    // FitAddon reads zeros and xterm freezes on its 80×24 default.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (this.currentProject !== project) return;

    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: '"JetBrains Mono", "Menlo", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostEl);
    this.terminal = term;
    this.fitAddon = fit;

    try { fit.fit(); } catch { /* host may briefly be 0×0 in flex layouts */ }
    const { cols, rows } = term;

    term.onData((data) => {
      const p = this.currentProject;
      if (p) this.api.terminalWrite(p, data);
    });
    term.onResize(({ cols: c, rows: r }) => {
      const p = this.currentProject;
      if (p) this.api.terminalResize(p, { cols: c, rows: r });
    });

    this.subs.add(this.stream.data$(project).subscribe((chunk) => term.write(chunk)));
    this.subs.add(this.stream.exit$(project).subscribe((e) => this.exitCode.set(e.code)));

    try {
      await this.api.terminalStart(project, { cols, rows });
    } catch (err) {
      console.error('[terminal] start failed:', err);
    }

    // ResizeObserver fires on window resize AND on the panel un-hiding
    // (display:none → block). Skip fits while the host is still 0×0 — fit()
    // throws on zero rows and leaves xterm's renderer in an inconsistent state.
    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 10 || rect.height < 10) return;
      try { this.fitAddon?.fit(); } catch { /* see above */ }
    });
    this.resizeObserver.observe(hostEl);

    term.focus();
  }

  private disposeTerminal(): void {
    this.subs.unsubscribe();
    this.subs = new Subscription();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.terminal) {
      try { this.terminal.dispose(); } catch { /* already disposed */ }
      this.terminal = null;
    }
    this.fitAddon = null;
  }
}
