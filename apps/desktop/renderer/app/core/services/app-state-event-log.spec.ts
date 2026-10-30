/**
 * UC-FIX-010 — Bound the per-message event log
 * UC-FIX-011 — Sweep the recentlyEnded grace map
 *
 * AppStateService uses Angular DI (inject()) and cannot be instantiated
 * standalone in the Vitest/Node runner. These tests require Angular TestBed
 * and should be added once an Angular test runner is wired.
 *
 * ── UC-FIX-010 test cases ────────────────────────────────────────────────
 *
 * AC1: event log capped at MAX_EVENTS after process end
 *   Setup: fire ProcessStartEvent, then emit 600 text_delta events,
 *          then fire ProcessEndEvent.
 *   Assert: the committed ChatMessage in chats() has events.length === 500
 *
 * AC2: event log under cap left intact
 *   Setup: fire start, emit 100 events, fire end.
 *   Assert: events.length === 100
 *
 * AC3: committed fields (text, toolCalls) unchanged by capping
 *   Setup: fire start, emit 600 text_delta, fire end.
 *   Assert: msg.text === concatenated text from all 600 deltas
 *
 * ── UC-FIX-011 test cases ────────────────────────────────────────────────
 *
 * AC1: stale grace entry removed by sweep
 *   Setup: fire a ProcessEndEvent (inserts a recentlyEnded entry).
 *          Advance fake time by GRACE_MS + 1.
 *          Trigger the 5s sweep interval.
 *   Assert: diff-snapshot for that project is NOT patched (entry gone).
 *
 * AC2: fresh entry still attaches diff snapshot
 *   Setup: fire ProcessEndEvent.
 *          Immediately emit a DiffSnapshotEvent for the same project.
 *   Assert: the finalised message has a diff payload attached.
 *
 * AC3: ngOnDestroy clears the sweep interval
 *   Setup: construct the service; call ngOnDestroy().
 *   Assert: no further sweep fires after destruction (check with spy on clearInterval).
 *
 * ── TestBed bootstrap snippet ─────────────────────────────────────────────
 *
 *   import { TestBed } from '@angular/core/testing';
 *   import { fakeAsync, tick } from '@angular/core/testing';
 *   import { AppStateService } from './app-state.service';
 *   import { ElectronApiService } from './electron-api.service';
 *
 *   // ... mock ElectronApiService with a Subject for each IPC event ...
 *
 *   describe('AppStateService — event log cap', () => {
 *     it('caps to MAX_EVENTS after process end', fakeAsync(() => {
 *       const svc = TestBed.inject(AppStateService);
 *       // emit ProcessStartEvent, then 600 claude:output events, then ProcessEndEvent
 *       // assert chats().get('proj')[last].events.length === 500
 *     }));
 *   });
 */

// This file intentionally contains no runnable test code.
// Logic is covered by typecheck and visual review.
import { describe, it } from 'vitest';

describe('AppStateService — event log cap (UC-FIX-010) and grace-map sweep (UC-FIX-011)', () => {
  it.todo('caps event log to MAX_EVENTS after process end (requires Angular TestBed + fakeAsync)');
  it.todo('sweep timer removes stale grace-map entries (requires Angular TestBed + fakeAsync)');
  it.todo('ngOnDestroy clears the sweep interval (requires Angular TestBed)');
});
