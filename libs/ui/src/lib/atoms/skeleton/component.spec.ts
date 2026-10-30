import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SkeletonComponent } from './component';

describe('SkeletonComponent', () => {
  let fixture: ComponentFixture<SkeletonComponent>;
  let component: SkeletonComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SkeletonComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SkeletonComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should be aria-hidden', () => {
    expect(fixture.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('should render multiple lines', () => {
    fixture.componentRef.setInput('lines', 3);
    fixture.detectChanges();
    const lines = fixture.nativeElement.querySelectorAll('.dv-skeleton__line');
    expect(lines.length).toBe(3);
  });

  it('should render circle for avatar variant', () => {
    fixture.componentRef.setInput('variant', 'avatar');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-skeleton__circle'),
    ).toBeTruthy();
  });
});
