import { TestBed } from '@angular/core/testing';
import { PillNavComponent, PillNavItem } from './component';

describe('PillNavComponent', () => {
  let fixture: ComponentFixture<PillNavComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PillNavComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(PillNavComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());

  it('emits activeChanged when item clicked', () => {
    const items = [{ id: 'tab1', label: 'Tab 1' }];
    fixture.componentRef.setInput('items', items);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.activeChanged.subscribe((id) => emitted.push(id));
    (
      fixture.componentInstance as PillNavComponent & {
        select: (item: PillNavItem) => void;
      }
    ).select(items[0]);
    expect(emitted).toContain('tab1');
  });
});
