/**
 * S-50: the "Instaladas" tab lets the user move a server between direct and code
 * mode. The tab only reports the choice; the modal calls the API.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { McpInstalledTabComponent } from './mcp-installed-tab.component';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import type { McpServerView } from '../../../../../types/devia';

function view(over: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'tiendas', name: 'Tiendas', command: 'npx', args: ['-y', 'x'], enabled: true,
    agents: ['claude'], scope: 'global', source: 'npm', pinned: false, ...over,
  };
}

function setup(servers: McpServerView[]) {
  TestBed.configureTestingModule({
    imports: [McpInstalledTabComponent, TranslateModule.forRoot()],
    providers: [{ provide: ElectronApiService, useValue: { mcpProbe: vi.fn() } }],
  });
  const fixture = TestBed.createComponent(McpInstalledTabComponent);
  fixture.componentRef.setInput('servers', servers);
  fixture.componentRef.setInput('loading', false);
  fixture.detectChanges();
  const emitted: Array<{ server: McpServerView; exposure: string }> = [];
  fixture.componentInstance.exposureChanged.subscribe((e) => emitted.push(e));
  return { fixture, component: fixture.componentInstance, emitted };
}

describe('McpInstalledTabComponent — exposure (S-50)', () => {
  it('shows a server without exposure as direct and a codemode one as code mode', () => {
    const { component } = setup([view(), view({ id: 'b', exposure: 'codemode' })]);
    expect(component.exposureOf(view())).toBe('direct');
    expect(component.exposureOf(view({ exposure: 'codemode' }))).toBe('codemode');
  });

  it('reports a switch to code mode with the server it applies to', () => {
    const server = view();
    const { component, emitted } = setup([server]);
    component.setExposure(server, 'codemode');
    expect(emitted).toEqual([{ server, exposure: 'codemode' }]);
  });

  it('reports a switch back to direct', () => {
    const server = view({ exposure: 'codemode' });
    const { component, emitted } = setup([server]);
    component.setExposure(server, 'direct');
    expect(emitted).toEqual([{ server, exposure: 'direct' }]);
  });

  it('says nothing when the choice is the one the server already has', () => {
    const { component, emitted } = setup([view({ exposure: 'codemode' })]);
    component.setExposure(view({ exposure: 'codemode' }), 'codemode');
    component.setExposure(view(), 'direct');
    expect(emitted).toEqual([]);
  });

  it('ignores a value that is not one of the two choices', () => {
    const { component, emitted } = setup([view()]);
    component.setExposure(view(), 'hidden');
    expect(emitted).toEqual([]);
  });

  it('renders the selector for the selected server', () => {
    const { fixture } = setup([view()]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('dv-button-toggle-group.exposure-toggle')).not.toBeNull();
    expect(el.querySelectorAll('.dvtg-item')).toHaveLength(2);
  });
});
