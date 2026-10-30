import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToggleComponent } from './component';

describe('ToggleComponent', () => {
  let fixture: ComponentFixture<ToggleComponent>;
  let component: ToggleComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToggleComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ToggleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());
  it('toggles on click', () => {
    (component as any).toggle();
    expect((component as any).checked()).toBe(true);
  });
  it('does not toggle when disabled', () => {
    component.setDisabledState(true);
    (component as any).toggle();
    expect((component as any).checked()).toBe(false);
  });
  it('writes value via CVA', () => {
    component.writeValue(true);
    expect((component as any).checked()).toBe(true);
  });
});
