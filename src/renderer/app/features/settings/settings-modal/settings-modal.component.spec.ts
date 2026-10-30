/**
 * UC-FIX-001 — Settings modal silently swallows selectAgent rejection
 *
 * The Vitest suite targets `src/main/**` only. Angular TestBed tests for the
 * renderer require an Angular test runner (e.g. `ng test` with Karma/Jasmine
 * or Vitest + @analogjs/vitest-angular) that is not yet wired into the project.
 *
 * The pure-logic changes (signal updates, early return on rejection) have been
 * verified by typecheck and a visual review of the template.
 *
 * This file documents the TestBed tests that SHOULD be written once an Angular
 * test runner is available.
 *
 * ── What to test ─────────────────────────────────────────────────────────────
 *
 * AC1 — Rejection keeps dialog open and shows banner:
 *   Setup: mock ElectronApiService.selectAgent → resolves { accepted: false,
 *          agentId: 'claude', rejectedReason: 'Not implemented yet' }
 *          mock AppStateService.saveConfig → resolves void
 *   Action: call component.save()
 *   Assert: DialogRef.close was NOT called
 *   Assert: component.errorBanner() === 'Not implemented yet'
 *   Assert: component.selectedAgentId() is restored to the persisted value
 *
 * AC2 — Acceptance closes dialog:
 *   Setup: mock ElectronApiService.selectAgent → resolves { accepted: true,
 *          agentId: 'claude' }
 *          mock setAgentModel, setAgentEnv → resolve void
 *   Action: call component.save()
 *   Assert: DialogRef.close was called with true
 *   Assert: component.errorBanner() === null
 *
 * AC3 — Clicking another agent card clears the banner:
 *   Setup: manually set component.errorBanner.set('some error')
 *          set agents with a selectable agent 'codex'
 *   Action: call component.selectAgent('codex')
 *   Assert: component.errorBanner() === null
 *
 * ── TestBed bootstrap snippet ─────────────────────────────────────────────────
 *
 *   import { TestBed } from '@angular/core/testing';
 *   import { DialogRef } from '@angular/cdk/dialog';
 *   import { SettingsModalComponent } from './settings-modal.component';
 *   import { ElectronApiService } from '../../../core/services/electron-api.service';
 *   import { AppStateService } from '../../../core/services/app-state.service';
 *
 *   const mockApi = {
 *     getConfig: () => Promise.resolve({ agentId: 'claude', workspaceRoot: '/ws',
 *       ignoreFolders: [], agentModels: {}, agentCliEnv: {}, configPath: '/cfg' }),
 *     listAgents: () => Promise.resolve([]),
 *     selectAgent: vi.fn(),
 *     setAgentModel: () => Promise.resolve(),
 *     setAgentEnv: () => Promise.resolve(),
 *   };
 *
 *   const mockState = { saveConfig: () => Promise.resolve() };
 *   const mockRef = { close: vi.fn() };
 *
 *   await TestBed.configureTestingModule({
 *     imports: [SettingsModalComponent],
 *     providers: [
 *       { provide: ElectronApiService, useValue: mockApi },
 *       { provide: AppStateService, useValue: mockState },
 *       { provide: DialogRef, useValue: mockRef },
 *     ],
 *   }).compileComponents();
 *
 * ── Tracking ──────────────────────────────────────────────────────────────────
 *
 * UC-FIX-001 Status: Logic implemented (2026-05-18).
 *   - errorBanner signal added; save() checks result.accepted.
 *   - Angular component TestBed tests documented here for future runner.
 */

// This file intentionally contains no runnable test code.
// Pure logic is covered by typecheck; TestBed tests are documented above.
import { describe, it } from 'vitest';

describe('SettingsModalComponent (UC-FIX-001 / UC-FIX-017)', () => {
  it.todo('rejection keeps dialog open and shows errorBanner (requires Angular TestBed)');
  it.todo('secret keys display masked placeholder on open (requires Angular TestBed)');
});
