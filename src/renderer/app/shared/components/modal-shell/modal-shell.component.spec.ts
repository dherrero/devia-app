import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { LucideSlidersHorizontal } from '@lucide/angular';
import { ButtonComponent } from '@devia/ui';
import { ModalShellComponent, type ModalNavSection } from './modal-shell.component';

@Component({
  standalone: true,
  imports: [ModalShellComponent, ButtonComponent],
  template: `
    <ds-modal-shell heading="Ajustes" [headingIcon]="null"
                    [sections]="sections" [(active)]="active">
      <div class="proj-main">main-{{ active }}</div>
      <div shellActions><dv-button class="proj-action" variant="primary" size="sm">Guardar</dv-button></div>
    </ds-modal-shell>
  `,
})
class HostComponent {
  sections: ModalNavSection[] = [
    { id: 'a', label: 'Alpha', icon: LucideSlidersHorizontal },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma', badge: 3 },
  ];
  active = 'a';
}

describe('ModalShellComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  it('renders one nav item per section', () => {
    expect(el.querySelectorAll('.ms-nav-item').length).toBe(3);
  });

  it('marks the active section in the rail', () => {
    const active = el.querySelector('.ms-nav-item.active .ms-nav-label');
    expect(active?.textContent?.trim()).toBe('Alpha');
  });

  it('renders the heading', () => {
    expect(el.querySelector('.ms-title')?.textContent).toContain('Ajustes');
  });

  it('renders an optional badge', () => {
    expect(el.querySelector('.ms-nav-badge')?.textContent?.trim()).toBe('3');
  });

  it('projects the main content and the action footer', () => {
    expect(el.querySelector('.ms-content .proj-main')?.textContent).toContain('main-a');
    expect(el.querySelector('.ms-foot .proj-action')).not.toBeNull();
  });

  it('switches the active section on nav click (two-way model)', () => {
    const items = el.querySelectorAll<HTMLButtonElement>('.ms-nav-item');
    items[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.active).toBe('b');
    expect(el.querySelector('.ms-nav-item.active .ms-nav-label')?.textContent?.trim()).toBe('Beta');
    expect(el.querySelector('.ms-content .proj-main')?.textContent).toContain('main-b');
  });
});
