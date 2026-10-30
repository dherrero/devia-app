import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ProgressComponent } from './component';

describe('ProgressComponent', () => {
  let fixture: ComponentFixture<ProgressComponent>;
  let component: ProgressComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProgressComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ProgressComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have role progressbar', () => {
    expect(fixture.nativeElement.getAttribute('role')).toBe('progressbar');
  });

  it('should set aria-valuenow when value provided', () => {
    fixture.componentRef.setInput('value', 50);
    fixture.detectChanges();
    expect(fixture.nativeElement.getAttribute('aria-valuenow')).toBe('50');
  });

  it('should be indeterminate when value is null', () => {
    fixture.componentRef.setInput('value', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.getAttribute('aria-valuenow')).toBeNull();
    expect(fixture.nativeElement.classList).toContain(
      'dv-progress--indeterminate',
    );
  });
});
