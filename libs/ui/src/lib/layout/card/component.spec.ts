import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CardComponent } from './component';

describe('CardComponent', () => {
  let fixture: ComponentFixture<CardComponent>;
  let component: CardComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CardComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());
  it('has default variant class', () => {
    expect(fixture.nativeElement.className).toContain('dv-card--default');
  });
  it('emits cardClick when interactive and clicked', () => {
    fixture.componentRef.setInput('interactive', true);
    fixture.detectChanges();
    const clicks: unknown[] = [];
    component.cardClick.subscribe((e) => clicks.push(e));
    fixture.nativeElement.click();
    expect(clicks.length).toBe(1);
  });
});
