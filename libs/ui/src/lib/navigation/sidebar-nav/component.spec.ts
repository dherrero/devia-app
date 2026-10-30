import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SidebarNavComponent } from './component';

describe('SidebarNavComponent', () => {
  let fixture: ComponentFixture<SidebarNavComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SidebarNavComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SidebarNavComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());

  it('collapses when collapsed=true', () => {
    fixture.componentRef.setInput('collapsed', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.className).toContain(
      'dv-sidebar-nav--collapsed',
    );
  });
});
