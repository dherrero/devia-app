import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatCardComponent } from './component';

describe('StatCardComponent', () => {
  let fixture: ComponentFixture<StatCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StatCardComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(StatCardComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());

  it('shows skeleton when loading', () => {
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-stat-card__skeleton'),
    ).toBeTruthy();
  });

  it('shows positive delta', () => {
    fixture.componentRef.setInput('delta', 5);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.dv-stat-card__delta--positive'),
    ).toBeTruthy();
  });
});
