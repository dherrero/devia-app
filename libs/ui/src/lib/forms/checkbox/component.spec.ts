import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CheckboxComponent } from './component';

describe('CheckboxComponent', () => {
  let fixture: ComponentFixture<CheckboxComponent>;
  let component: CheckboxComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CheckboxComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CheckboxComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());
  it('toggles checked state', () => {
    (component as any).toggle();
    expect((component as any).checked()).toBe(true);
  });
  it('disables via CVA', () => {
    component.setDisabledState(true);
    expect((component as any).isDisabled()).toBe(true);
  });
});
