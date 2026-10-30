import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SpinnerComponent } from './component';

describe('SpinnerComponent', () => {
  let fixture: ComponentFixture<SpinnerComponent>;
  let component: SpinnerComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SpinnerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SpinnerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should be aria-hidden', () => {
    expect(fixture.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('should render SVG', () => {
    expect(fixture.nativeElement.querySelector('svg')).toBeTruthy();
  });

  it('should apply size class', () => {
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-spinner--sm');
  });
});
