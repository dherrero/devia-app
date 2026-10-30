import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TopbarComponent } from './component';

describe('TopbarComponent', () => {
  let fixture: ComponentFixture<TopbarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TopbarComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(TopbarComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());

  it('renders breadcrumbs', () => {
    fixture.componentRef.setInput('breadcrumbs', [
      { label: 'Home', href: '/' },
      { label: 'Projects' },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.dv-breadcrumb')).toBeTruthy();
  });
});
