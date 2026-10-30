import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AvatarGroupComponent, AvatarData } from './avatar-group.component';
import { By } from '@angular/platform-browser';

describe('AvatarGroupComponent', () => {
  let fixture: ComponentFixture<AvatarGroupComponent>;
  let component: AvatarGroupComponent;

  const avatars: AvatarData[] = [
    { id: '1', name: 'Alice', initials: 'AL' },
    { id: '2', name: 'Bob', initials: 'BO' },
    { id: '3', name: 'Carol', initials: 'CA' },
    { id: '4', name: 'Dave', initials: 'DA' },
    { id: '5', name: 'Eve', initials: 'EV' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AvatarGroupComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AvatarGroupComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render only maxVisible avatars by default (3)', () => {
    fixture.componentRef.setInput('avatars', avatars);
    fixture.detectChanges();

    const avatarEls = fixture.debugElement.queryAll(By.css('dv-avatar'));
    expect(avatarEls.length).toBe(3);
  });

  it('should show overflow count when avatars exceed maxVisible', () => {
    fixture.componentRef.setInput('avatars', avatars);
    fixture.componentRef.setInput('maxVisible', 3);
    fixture.detectChanges();

    const overflow = fixture.debugElement.query(
      By.css('.dv-avatar-group__overflow'),
    );
    expect(overflow).toBeTruthy();
    expect(overflow.nativeElement.textContent.trim()).toBe('+2');
  });

  it('should not show overflow when avatars fit within maxVisible', () => {
    fixture.componentRef.setInput('avatars', avatars.slice(0, 3));
    fixture.componentRef.setInput('maxVisible', 3);
    fixture.detectChanges();

    const overflow = fixture.debugElement.query(
      By.css('.dv-avatar-group__overflow'),
    );
    expect(overflow).toBeNull();
  });

  it('should render all avatars when maxVisible exceeds total', () => {
    fixture.componentRef.setInput('avatars', avatars.slice(0, 2));
    fixture.componentRef.setInput('maxVisible', 5);
    fixture.detectChanges();

    const avatarEls = fixture.debugElement.queryAll(By.css('dv-avatar'));
    expect(avatarEls.length).toBe(2);
  });

  it('should apply the size class to host', () => {
    fixture.componentRef.setInput('avatars', avatars);
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();

    expect(
      fixture.debugElement.nativeElement.classList.contains(
        'dv-avatar-group--lg',
      ),
    ).toBe(true);
  });

  it('should pass size to each rendered dv-avatar', () => {
    fixture.componentRef.setInput('avatars', avatars.slice(0, 2));
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();

    const avatarEls = fixture.debugElement.queryAll(By.css('dv-avatar'));
    avatarEls.forEach((el) => {
      expect(el.nativeElement.classList.contains('dv-avatar--sm')).toBe(true);
    });
  });

  it('should have role=group on the host', () => {
    fixture.detectChanges();
    expect(fixture.debugElement.nativeElement.getAttribute('role')).toBe(
      'group',
    );
  });
});
