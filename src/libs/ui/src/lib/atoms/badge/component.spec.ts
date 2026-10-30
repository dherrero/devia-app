import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BadgeComponent } from './component';

describe('BadgeComponent', () => {
  let fixture: ComponentFixture<BadgeComponent>;
  let component: BadgeComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BadgeComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(BadgeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have default neutral variant and md size class', () => {
    expect(fixture.nativeElement.className).toContain('dv-badge--neutral');
    expect(fixture.nativeElement.className).toContain('dv-badge--md');
  });

  it('should apply accent variant class', () => {
    fixture.componentRef.setInput('variant', 'accent');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-badge--accent');
  });

  it('should apply sm size class', () => {
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-badge--sm');
  });

  it('should render dot element when dot is true', () => {
    fixture.componentRef.setInput('dot', true);
    fixture.detectChanges();
    const dot = fixture.nativeElement.querySelector('.dv-badge__dot');
    expect(dot).toBeTruthy();
  });

  it('should not render dot element when dot is false', () => {
    fixture.detectChanges();
    const dot = fixture.nativeElement.querySelector('.dv-badge__dot');
    expect(dot).toBeNull();
  });
});
