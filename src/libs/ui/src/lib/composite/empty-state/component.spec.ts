import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EmptyStateComponent } from './component';

describe('EmptyStateComponent', () => {
  it('creates with required title', async () => {
    await TestBed.configureTestingModule({
      imports: [EmptyStateComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(EmptyStateComponent);
    fixture.componentRef.setInput('title', 'No hay datos');
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
    expect(
      fixture.nativeElement.querySelector('.dv-empty-state__title').textContent,
    ).toContain('No hay datos');
  });
});
