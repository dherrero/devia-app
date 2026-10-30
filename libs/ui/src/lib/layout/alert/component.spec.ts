import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AlertComponent } from './component';

describe('AlertComponent', () => {
  let fixture: ComponentFixture<AlertComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AlertComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(AlertComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());
  it('applies variant class', () => {
    fixture.componentRef.setInput('variant', 'danger');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-alert--danger');
  });
});
