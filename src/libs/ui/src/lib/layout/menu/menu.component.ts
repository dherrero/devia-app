import {
  ChangeDetectionStrategy,
  Component,
  ComponentRef,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Overlay, OverlayRef, ConnectedPosition } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { MenuPanelComponent } from './menu-panel.component';
import { MenuItemDef } from './menu.models';

@Component({
  selector: 'dv-menu',
  imports: [],
  templateUrl: './menu.component.html',
  styleUrl: './menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MenuComponent implements OnDestroy {
  readonly items = input<MenuItemDef[]>([]);

  readonly itemActivated = output<MenuItemDef>();
  readonly opened = output<void>();
  readonly closed = output<void>();

  private triggerEl: ElementRef<HTMLElement> | null = null;
  private readonly overlay = inject(Overlay);
  private overlayRef: OverlayRef | null = null;
  private panelRef: ComponentRef<MenuPanelComponent> | null = null;

  readonly isOpen = signal(false);

  constructor() {
    effect(() => {
      const items = this.items();
      this.panelRef?.setInput('items', items);
      this.overlayRef?.updatePosition();
    });
  }

  registerTrigger(ref: ElementRef<HTMLElement>): void {
    this.triggerEl = ref;
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.overlayRef?.hasAttached()) return;

    const origin = this.triggerEl?.nativeElement;
    if (!origin) return;

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(origin)
      .withPositions(this.getPositions())
      .withPush(true);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.close(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
    });

    this.overlayRef.backdropClick().subscribe(() => this.close());
    this.overlayRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') this.close();
    });

    const portal = new ComponentPortal(MenuPanelComponent);
    const compRef = this.overlayRef.attach(portal);
    this.panelRef = compRef;

    compRef.setInput('items', this.items());
    compRef.instance.itemActivated.subscribe((item: MenuItemDef) => {
      this.itemActivated.emit(item);
      if (!('closeOnActivate' in item) || item.closeOnActivate !== false) {
        this.close();
      }
    });
    compRef.instance.closed.subscribe(() => this.close());

    this.isOpen.set(true);
    this.opened.emit();
  }

  close(): void {
    this.overlayRef?.detach();
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.panelRef = null;
    this.isOpen.set(false);
    this.closed.emit();
    this.triggerEl?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    this.overlayRef?.dispose();
    this.panelRef = null;
  }

  private getPositions(): ConnectedPosition[] {
    return [
      {
        originX: 'end',
        originY: 'bottom',
        overlayX: 'end',
        overlayY: 'top',
        offsetY: 4,
      },
      {
        originX: 'end',
        originY: 'top',
        overlayX: 'end',
        overlayY: 'bottom',
        offsetY: -4,
      },
      {
        originX: 'start',
        originY: 'bottom',
        overlayX: 'start',
        overlayY: 'top',
        offsetY: 4,
      },
    ];
  }
}
