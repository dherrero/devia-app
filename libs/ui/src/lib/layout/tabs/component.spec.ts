import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TabsComponent } from './component';

describe('TabsComponent', () => {
  let fixture: ComponentFixture<TabsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TabsComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(TabsComponent);
    fixture.detectChanges();
  });

  it('creates', () => expect(fixture.componentInstance).toBeTruthy());

  it('selects a tab on click', () => {
    const tabs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    fixture.componentRef.setInput('tabs', tabs);
    fixture.detectChanges();
    (
      fixture.componentInstance as TabsComponent & {
        selectTab: (t: { id: string; label: string }) => void;
      }
    ).selectTab(tabs[1]);
    expect(fixture.componentInstance.value()).toBe('b');
  });

  describe('variant (HT-C-01)', () => {
    it('defaults to the underline variant — no pill host class', () => {
      const host = fixture.nativeElement as HTMLElement;
      expect(fixture.componentInstance.variant()).toBe('underline');
      expect(host.classList.contains('dv-tabs--pill')).toBe(false);
    });

    it('toggles the pill host class when variant="pill"', () => {
      fixture.componentRef.setInput('variant', 'pill');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.classList.contains('dv-tabs--pill')).toBe(true);
    });

    it('keeps ARIA tab semantics across variants (a11y is not visual)', () => {
      fixture.componentRef.setInput('tabs', [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ]);
      fixture.componentRef.setInput('value', 'a');
      fixture.componentRef.setInput('variant', 'pill');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const list = host.querySelector('[role="tablist"]');
      const activeTab = host.querySelector(
        '[role="tab"][aria-selected="true"]',
      );
      expect(list).not.toBeNull();
      expect(activeTab?.id).toBe('tab-a');
    });

    it('keyboard navigation still cycles in the pill variant', () => {
      const tabs = [
        { id: 'chat', label: 'Chat' },
        { id: 'changes', label: 'Cambios' },
      ];
      fixture.componentRef.setInput('tabs', tabs);
      fixture.componentRef.setInput('value', 'chat');
      fixture.componentRef.setInput('variant', 'pill');
      fixture.detectChanges();
      const instance = fixture.componentInstance as TabsComponent & {
        onKeydown: (e: KeyboardEvent) => void;
      };
      instance.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(fixture.componentInstance.value()).toBe('changes');
    });
  });
});
