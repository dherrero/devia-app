import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TextareaComponent } from './component';

describe('TextareaComponent', () => {
  let fixture: ComponentFixture<TextareaComponent>;
  let component: TextareaComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextareaComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TextareaComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should update value via writeValue', () => {
    component.writeValue('hello');
    expect(component.value()).toBe('hello');
  });

  it('should show error', () => {
    fixture.componentRef.setInput('error', 'Required');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-field__error').textContent,
    ).toContain('Required');
  });

  it('should call onChange on input', () => {
    const onChange = vi.fn();
    component.registerOnChange(onChange);
    const ta = fixture.nativeElement.querySelector(
      '[data-testid="dv-textarea"]',
    );
    ta.value = 'new value';
    ta.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('new value');
  });
});
