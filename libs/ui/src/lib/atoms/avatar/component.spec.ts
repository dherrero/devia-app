import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AvatarComponent } from './component';

describe('AvatarComponent', () => {
  let fixture: ComponentFixture<AvatarComponent>;
  let component: AvatarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AvatarComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AvatarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should show initials when no src', () => {
    fixture.componentRef.setInput('initials', 'AB');
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.dv-avatar__initials');
    expect(el.textContent).toContain('AB');
  });

  it('should apply size class', () => {
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain('dv-avatar--lg');
  });
});
