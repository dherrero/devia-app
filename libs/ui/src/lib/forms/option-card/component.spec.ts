import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OptionCardComponent } from './component';

describe('OptionCardComponent', () => {
  let fixture: ComponentFixture<OptionCardComponent>;
  let component: OptionCardComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OptionCardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OptionCardComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('label', 'Blank project');
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('emits selectedChange on click', () => {
    const spy = vi.fn();
    component.selectedChange.subscribe(spy);
    fixture.nativeElement
      .querySelector('[data-testid="dv-option-card"]')
      .click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not emit when disabled', () => {
    const spy = vi.fn();
    component.selectedChange.subscribe(spy);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('[data-testid="dv-option-card"]')
      .click();
    expect(spy).not.toHaveBeenCalled();
  });
});
