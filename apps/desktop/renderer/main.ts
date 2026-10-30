import { importProvidersFrom, provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { provideRouter, withHashLocation } from '@angular/router';
import { DialogModule } from '@angular/cdk/dialog';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { detectSystemLanguage } from './app/core/i18n/supported-languages';

function httpTranslateLoader(http: HttpClient) {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

// Use the OS-detected language as the default so the first paint matches
// the user's locale before AppStateService loads any persisted override.
// The persisted choice (cfg.language) still wins once it arrives — see
// I18nService — but using the detected language here avoids a flash of the
// fallback locale during the first ~100ms of startup.
//
// `withHashLocation` is used because the renderer is loaded over a
// `file://` URL inside Electron; the default PathLocationStrategy needs
// a real base href and would otherwise 404 on reload. Hash routing is
// transparent to the user (the router rewrites the visible URL) and
// avoids needing an Express-style catch-all on the renderer's index.html.
bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideAnimations(),
    provideHttpClient(),
    importProvidersFrom(DialogModule),
    provideRouter(routes, withHashLocation()),
    importProvidersFrom(
      TranslateModule.forRoot({
        defaultLanguage: detectSystemLanguage(),
        loader: {
          provide: TranslateLoader,
          useFactory: httpTranslateLoader,
          deps: [HttpClient],
        },
      }),
    ),
  ],
}).catch((err: unknown) => console.error('[bootstrap]', err));
