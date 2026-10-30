import { Injectable, inject } from '@angular/core';
import { Observable, Subject, filter, map } from 'rxjs';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import type { TerminalDataEvent, TerminalExitEvent } from '../../../../../types/devia';

/**
 * Singleton bridge between the main-process pty stream and the per-project
 * Angular terminal panels. We subscribe to the global IPC listeners exactly
 * once (preload registers them for the lifetime of the renderer anyway) and
 * fan-out via per-project filtered Observables — keeps every terminal panel
 * decoupled and lets us swap projects without losing in-flight chunks.
 */
@Injectable({ providedIn: 'root' })
export class TerminalStreamService {
  private readonly api = inject(ElectronApiService);
  private readonly data$$ = new Subject<TerminalDataEvent>();
  private readonly exit$$ = new Subject<TerminalExitEvent>();

  constructor() {
    this.api.onTerminalData((e) => this.data$$.next(e));
    this.api.onTerminalExit((e) => this.exit$$.next(e));
  }

  data$(project: string): Observable<string> {
    return this.data$$.pipe(
      filter((e) => e.project === project),
      map((e) => e.data),
    );
  }

  exit$(project: string): Observable<TerminalExitEvent> {
    return this.exit$$.pipe(filter((e) => e.project === project));
  }
}
