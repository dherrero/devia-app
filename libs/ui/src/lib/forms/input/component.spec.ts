import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InputComponent } from './component';

describe('InputComponent', () => {
  let fixture: ComponentFixture<InputComponent>;
  let component: InputComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InputComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(InputComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render label when provided', () => {
    fixture.componentRef.setInput('label', 'Email');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-field__label').textContent,
    ).toContain('Email');
  });

  it('should show error message', () => {
    fixture.componentRef.setInput('error', 'Field is required');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-field__error').textContent,
    ).toContain('Field is required');
  });

  it('should update value via writeValue', () => {
    component.writeValue('hello');
    fixture.detectChanges();
    expect(component.value()).toBe('hello');
  });

  it('should call onChange when input changes', () => {
    const onChange = vi.fn();
    component.registerOnChange(onChange);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="dv-input"]',
    );
    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('test');
  });

  it('should call onTouched on blur', () => {
    const onTouched = vi.fn();
    component.registerOnTouched(onTouched);
    const input = fixture.nativeElement.querySelector(
      '[data-testid="dv-input"]',
    );
    input.dispatchEvent(new FocusEvent('blur'));
    expect(onTouched).toHaveBeenCalled();
  });
});
