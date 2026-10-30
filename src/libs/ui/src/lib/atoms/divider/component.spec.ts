import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DividerComponent } from './component';

describe('DividerComponent', () => {
  let fixture: ComponentFixture<DividerComponent>;
  let component: DividerComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DividerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DividerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have role separator', () => {
    expect(fixture.nativeElement.getAttribute('role')).toBe('separator');
  });

  it('should show label when provided', () => {
    fixture.componentRef.setInput('label', 'OR');
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.dv-divider__label');
    expect(el.textContent).toContain('OR');
  });

  it('should apply vertical class', () => {
    fixture.componentRef.setInput('orientation', 'vertical');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-divider--vertical');
  });
});
