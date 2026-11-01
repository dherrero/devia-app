import '@analogjs/vitest-angular/setup-zone';
import '@angular/compiler';

import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';
import { getTestBed } from '@angular/core/testing';
import { beforeEach } from 'vitest';

try {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
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
