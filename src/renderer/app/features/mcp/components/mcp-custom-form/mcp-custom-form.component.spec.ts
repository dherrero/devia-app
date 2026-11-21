/**
 * T-562: the form edits an installed server. Its id and scope identify it, so while
 * editing they cannot be changed (changing either would silently create a second server).
 */
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { McpCustomFormComponent } from './mcp-custom-form.component';
import { emptyForm } from '../../models/mcp-form.model';

function mount(editing: boolean) {
  TestBed.configureTestingModule({ imports: [McpCustomFormComponent, TranslateModule.forRoot()] });
  const fixture = TestBed.createComponent(McpCustomFormComponent);
  fixture.componentRef.setInput('form', { ...emptyForm('/p'), id: 'tiendas', scope: 'global' });
  fixture.componentRef.setInput('projectPath', '/p');
  fixture.componentRef.setInput('editing', editing);
  fixture.detectChanges();
  return fixture;
}

describe('McpCustomFormComponent — editing (T-562)', () => {
  it('locks the id input while editing and leaves it free when adding', () => {
    const editing = (mount(false).nativeElement as HTMLElement).querySelector('dv-input input') as HTMLInputElement;
    expect(editing.disabled).toBe(false);
    TestBed.resetTestingModule();
    const locked = (mount(true).nativeElement as HTMLElement).querySelector('dv-input input') as HTMLInputElement;
    expect(locked.disabled).toBe(true);
  });

  it('does not let the scope change while editing', () => {
    const fixture = mount(true);
    fixture.componentInstance.setScope('project');
    expect(fixture.componentInstance.form().scope).toBe('global');
  });

  it('lets the scope change when adding a server', () => {
    const fixture = mount(false);
    fixture.componentInstance.setScope('project');
    expect(fixture.componentInstance.form().scope).toBe('project');
  });
});
