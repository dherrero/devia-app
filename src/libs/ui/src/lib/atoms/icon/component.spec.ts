import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IconComponent } from './component';
import { LucideHome } from '@lucide/angular';

describe('IconComponent', () => {
  let fixture: ComponentFixture<IconComponent>;
  let component: IconComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [IconComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(IconComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('icon', LucideHome);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should be aria-hidden by default', () => {
    expect(fixture.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('should expose aria-label when not decorative', () => {
    fixture.componentRef.setInput('decorative', false);
    fixture.componentRef.setInput('label', 'Home icon');
    fixture.detectChanges();
    expect(fixture.nativeElement.getAttribute('aria-label')).toBe('Home icon');
    expect(fixture.nativeElement.getAttribute('aria-hidden')).toBeNull();
  });

  it('should apply size class', () => {
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-icon--lg');
  });
});
