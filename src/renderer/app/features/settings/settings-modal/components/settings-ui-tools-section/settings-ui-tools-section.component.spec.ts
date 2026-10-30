import type { DetectedAgentView } from '../../../../../../types/devia';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConfirmationGrant,
  UiToolCatalogEntry,
  UiToolName,
} from '../../../../../../../shared/domain/ui-tools';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { SettingsUiToolsSectionComponent } from './settings-ui-tools-section.component';

const CATALOG: UiToolCatalogEntry[] = [
  {
    name: 'ask_user',
    publicName: 'devia_ask_user',
    description: 'Ask the user to pick',
    kind: 'blocking',
    schemaChars: 1400,
  },
  {
    name: 'todo',
    publicName: 'devia_todo',
    description: 'Publish a step list',
    kind: 'fire_and_forget',
    schemaChars: 700,
  },
];

const GRANTS: ConfirmationGrant[] = [
  { action: 'rm -rf dist', label: 'rm -rf dist', grantedAt: '2026-07-31T00:00:00.000Z' },
];

const listUiToolCatalog = vi.fn(async () => CATALOG);
const listUiToolGrants = vi.fn(async () => GRANTS);
const revokeUiToolGrant = vi.fn(async () => undefined);

/** The view cli-adapters sends: capabilities come from the agent's mapper (S-30). */
function agentView(id: string, mcp: 'native' | 'devia' | 'none'): DetectedAgentView {
  return {
    id, name: id, bin: id, streamFormat: 'plain', models: [], available: true,
    providerType: 'cli', applicability: 'direct', selectable: true,
    harness: { mcp, skills: mcp === 'none' ? 'none' : 'devia', subagents: mcp === 'none' ? 'none' : 'devia', isolatesExternalMcp: false },
  };
}

async function mount(
  agentId = 'claude',
  mcp: 'native' | 'devia' | 'none' = 'native',
): Promise<{ el: HTMLElement; comp: SettingsUiToolsSectionComponent; detect: () => Promise<void> }> {
  const fixture: ComponentFixture<SettingsUiToolsSectionComponent> = TestBed.createComponent(
    SettingsUiToolsSectionComponent,
  );
  fixture.componentRef.setInput('selectedAgentId', agentId);
  fixture.componentRef.setInput('selectedAgent', agentView(agentId, mcp));
  fixture.componentRef.setInput('project', '/ws/proj-a');
  const detect = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  // The effect fires the same load in the app; awaiting it explicitly here
  // removes the scheduling race from the assertions.
  await fixture.componentInstance.reload();
  await detect();
  return { el: fixture.nativeElement as HTMLElement, comp: fixture.componentInstance, detect };
}

function toggleFor(el: HTMLElement, publicName: string): HTMLButtonElement {
  const match = [...el.querySelectorAll('.dsm-ui-tools-section__toggle')].find((b) =>
    (b.textContent ?? '').includes(publicName),
  );
  if (!match) throw new Error(`no toggle for ${publicName}`);
  return match as HTMLButtonElement;
}

describe('SettingsUiToolsSectionComponent (S-25 F3.3)', () => {
  beforeEach(() => {
    listUiToolCatalog.mockClear();
    listUiToolGrants.mockClear();
    revokeUiToolGrant.mockClear();
    TestBed.configureTestingModule({
      imports: [SettingsUiToolsSectionComponent, TranslateModule.forRoot()],
      providers: [
        {
          provide: ElectronApiService,
          useValue: { listUiToolCatalog, listUiToolGrants, revokeUiToolGrant },
        },
      ],
    });
  });

  // The interpolated labels are asserted through the component's computed
  // values, not the rendered text: TranslateModule.forRoot() with no catalogue
  // renders the raw key and never substitutes `{{tokens}}`.
  it('lists every tool with its own token cost', async () => {
    const { el, comp } = await mount();

    expect(el.textContent).toContain('devia_ask_user');
    expect(el.textContent).toContain('devia_todo');
    // 1400 chars / 3.5 = 400 tokens.
    expect(comp.tokensOf(CATALOG[0] as UiToolCatalogEntry)).toBe(400);
  });

  it('shows the total of the ACTIVE set, not of everything', async () => {
    const { comp, detect } = await mount();
    // Both on by default → (1400 + 700) / 3.5 = 600.
    expect(comp.activeTokens()).toBe(600);

    comp.enabled.set({ ask_user: false });
    await detect();

    // Only devia_todo left → 700 / 3.5 = 200.
    expect(comp.activeTokens()).toBe(200);
  });

  it('an absent entry means "mode default", so the tool reads as on', async () => {
    const { el } = await mount();

    expect(toggleFor(el, 'devia_todo').getAttribute('aria-checked')).toBe('true');
  });

  it('toggling off writes an explicit false; toggling on removes the entry', async () => {
    const { el, comp, detect } = await mount();

    toggleFor(el, 'devia_todo').click();
    await detect();
    expect(comp.enabled()).toEqual({ todo: false });

    toggleFor(el, 'devia_todo').click();
    await detect();
    // Back to "use the default" rather than an explicit true, so the tool never
    // gets forced into a mode whose policy does not offer it.
    expect(comp.enabled()).toEqual({});
    expect((comp.enabled() as Record<string, unknown>)['todo']).toBeUndefined();
  });

  it('warns and locks the toggles for an agent with no MCP support', async () => {
    const { el, comp } = await mount('deepseek', 'none');

    expect(comp.agentSupported()).toBe(false);
    expect(toggleFor(el, 'devia_todo').disabled).toBe(true);
  });

  it('keeps the toggles usable for an agent that does support MCP', async () => {
    const { el, comp } = await mount('codex', 'native');

    expect(comp.agentSupported()).toBe(true);
    expect(toggleFor(el, 'devia_todo').disabled).toBe(false);
  });

  it('lists the always-allow grants and revokes one', async () => {
    const { el, detect } = await mount();
    expect(el.textContent).toContain('rm -rf dist');

    const revoke = [...el.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('revoke'),
    ) as HTMLButtonElement;
    revoke.click();
    await detect();

    expect(revokeUiToolGrant).toHaveBeenCalledWith('/ws/proj-a', 'rm -rf dist');
  });

  it('survives a main process that cannot answer, instead of blanking', async () => {
    listUiToolCatalog.mockRejectedValueOnce(new Error('nope'));
    listUiToolGrants.mockRejectedValueOnce(new Error('nope'));

    await expect(mount()).resolves.toBeDefined();
  });

  it('asks for grants only when a project is selected', async () => {
    const fixture = TestBed.createComponent(SettingsUiToolsSectionComponent);
    fixture.componentRef.setInput('selectedAgentId', 'claude');
    fixture.componentRef.setInput('project', '');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(listUiToolGrants).not.toHaveBeenCalled();
  });
});
