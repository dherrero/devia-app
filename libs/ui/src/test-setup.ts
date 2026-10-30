import '@analogjs/vitest-angular/setup-zone';

import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { getTestBed } from '@angular/core/testing';
import { beforeEach } from 'vitest';

try {
  getTestBed().initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting(),
    {
      errorOnUnknownElements: true,
      errorOnUnknownProperties: true,
    },
  );
} catch {
  // Already initialised in this worker
}

beforeEach(() => {
  getTestBed().resetTestingModule();
});
