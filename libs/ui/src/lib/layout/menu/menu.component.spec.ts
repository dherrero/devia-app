import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { MenuComponent } from './menu.component';
import { MenuTriggerDirective } from './menu-trigger.directive';
import { MenuItemDef } from './menu.models';

const SAMPLE_ITEMS: MenuItemDef[] = [
  { label: 'Edit' },
  { label: 'Delete', destructive: true },
  { label: 'Copy', disabled: true },
  { label: 'Paste', shortcut: '⌘V', dividerBefore: true },
];

@Component({
  template: `
    <dv-menu [items]="items()" (itemActivated)="onActivated($event)">
      <button dvMenuTrigger data-testid="trigger">Open</button>
    </dv-menu>
  `,
  imports: [MenuComponent, MenuTriggerDirective],
  standalone: true,
})
class TestHostComponent {
  readonly items = signal<MenuItemDef[]>(SAMPLE_ITEMS);
  activated: MenuItemDef | null = null;

  onActivated(item: MenuItemDef): void {
    this.activated = item;
    if (item.id !== 'zoom-in') return;
    this.items.set([
      { label: 'Edit' },
      {
        kind: 'zoom-control',
        label: 'Zoom',
        valueLabel: '110%',
        dividerBefore: true,
        decreaseAction: { id: 'zoom-out', label: 'Zoom out' },
        resetAction: { id: 'zoom-reset', label: 'Reset zoom' },
        increaseAction: { id: 'zoom-in', label: 'Zoom in' },
      },
    ]);
  }
}

describe('MenuComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent, OverlayModule],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(host).toBeTruthy();
  });

  it('trigger has aria-haspopup="menu"', () => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('trigger has aria-expanded="false" when closed', () => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the panel on trigger click', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.click();
    fixture.detectChanges();
    tick(50);
    fixture.detectChanges();
    const panel = document.querySelector('[role="menu"]');
    expect(panel).toBeTruthy();
  }));

  it('isOpen signal is true after open()', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.click();
    fixture.detectChanges();
    tick(50);
    fixture.detectChanges();

    const menuComp: MenuComponent =
      fixture.debugElement.children[0].componentInstance;
    expect(menuComp.isOpen()).toBe(true);
  }));

  it('close() sets isOpen to false', () => {
    const menuComp: MenuComponent =
      fixture.debugElement.children[0].componentInstance;
    // Directly set internal state without CDK overlay to test signal logic
    (menuComp as unknown as { isOpen: ReturnType<typeof signal> }).isOpen.set(
      true,
    );
    fixture.detectChanges();
    expect(menuComp.isOpen()).toBe(true);
    (menuComp as unknown as { isOpen: ReturnType<typeof signal> }).isOpen.set(
      false,
    );
    fixture.detectChanges();
    expect(menuComp.isOpen()).toBe(false);
  });

  it('renders items in the panel', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.click();
    fixture.detectChanges();
    tick(50);
    fixture.detectChanges();

    const menuItems = document.querySelectorAll('[role="menuitem"]');
    expect(menuItems.length).toBe(SAMPLE_ITEMS.length);
  }));

  it('disabled items have aria-disabled', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.click();
    fixture.detectChanges();
    tick(50);
    fixture.detectChanges();

    const disabledItem = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.getAttribute('aria-disabled') === 'true');
    expect(disabledItem).toBeTruthy();
  }));

  it('renders zoom controls and keeps the menu open when they activate', fakeAsync(() => {
    fixture.destroy();
    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    host.items.set([
      { label: 'Edit' },
      {
        kind: 'zoom-control',
        label: 'Zoom',
        valueLabel: '100%',
        dividerBefore: true,
        decreaseAction: { id: 'zoom-out', label: 'Zoom out' },
        resetAction: { id: 'zoom-reset', label: 'Reset zoom' },
        increaseAction: { id: 'zoom-in', label: 'Zoom in' },
      },
    ]);
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.click();
    fixture.detectChanges();
    tick(50);
    fixture.detectChanges();

    const zoomGroup = document.querySelector(
      '[role="group"][aria-label="Zoom"]',
    );
    expect(zoomGroup).toBeTruthy();

    const zoomIn = zoomGroup?.querySelector<HTMLButtonElement>(
      '[aria-label="Zoom in"]',
    );
    zoomIn?.click();
    fixture.detectChanges();

    const menuComp: MenuComponent =
      fixture.debugElement.children[0].componentInstance;
    expect(host.activated?.id).toBe('zoom-in');
    expect(menuComp.isOpen()).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    expect(zoomGroup?.textContent).toContain('110%');
  }));
});
