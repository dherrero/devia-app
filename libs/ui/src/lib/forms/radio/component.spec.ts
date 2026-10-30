import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RadioGroupComponent } from './component';

describe('RadioGroupComponent', () => {
  let fixture: ComponentFixture<RadioGroupComponent>;
  let component: RadioGroupComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RadioGroupComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(RadioGroupComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());
  it('writes value via CVA', () => {
    component.writeValue('foo');
    expect((component as any).selected()).toBe('foo');
  });
});
