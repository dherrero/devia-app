/**
 * UC-FIX-019: Angular TestBed initialiser for the Vitest renderer suite.
 * This file is referenced in vitest.angular.config.ts `setupFiles`.
 */
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

setupTestBed({ zoneless: false });
