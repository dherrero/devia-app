import { Directive, ElementRef, OnDestroy, inject, input } from '@angular/core';
import { Overlay, OverlayRef, ConnectedPosition } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { TooltipPanelComponent } from './tooltip-panel.component';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

@Directive({
  selector: '[dvTooltip]',
  host: {
    '(mouseenter)': 'onMouseEnter()',
    '(mouseleave)': 'onMouseLeave()',
    '(focus)': 'onFocus()',
    '(blur)': 'onBlur()',
    '(pointerdown)': 'close()',
    '(keydown.escape)': 'close()',
  },
})
export class TooltipDirective implements OnDestroy {
  readonly dvTooltip = input.required<string>();
  readonly dvTooltipPosition = input<TooltipPosition>('top');
  readonly dvTooltipDisabled = input(false);

  private readonly overlay = inject(Overlay);
  private readonly elementRef = inject(ElementRef);
  private overlayRef: OverlayRef | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  onMouseEnter(): void {
    this.scheduleOpen();
  }

  onMouseLeave(): void {
    this.scheduleClose();
  }

  onFocus(): void {
    this.scheduleOpen();
  }

  onBlur(): void {
    this.scheduleClose();
  }

  private scheduleOpen(): void {
    if (this.dvTooltipDisabled()) return;
    if (!this.dvTooltip().trim()) return;
    this.cancelClose();
    this.openTimer = setTimeout(() => this.open(), 300);
  }

  private scheduleClose(): void {
    this.cancelOpen();
    this.closeTimer = setTimeout(() => this.close(), 80);
  }

  private cancelOpen(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private cancelClose(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  open(): void {
    if (this.dvTooltipDisabled()) return;
    const text = this.dvTooltip().trim();
    if (!text) return;
    if (this.overlayRef?.hasAttached()) return;

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(this.elementRef)
      .withPositions(this.getPositions());

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.close(),
      panelClass: 'dv-tooltip-panel',
    });
    this.overlayRef.hostElement.style.pointerEvents = 'none';
    this.overlayRef.overlayElement.style.pointerEvents = 'none';

    const portal = new ComponentPortal(TooltipPanelComponent);
    const ref = this.overlayRef.attach(portal);
    ref.setInput('text', text);
  }

  close(): void {
    this.cancelOpen();
    this.overlayRef?.detach();
    this.overlayRef?.dispose();
    this.overlayRef = null;
  }

  ngOnDestroy(): void {
    this.cancelOpen();
    this.cancelClose();
    this.overlayRef?.dispose();
  }

  private getPositions(): ConnectedPosition[] {
    const pos = this.dvTooltipPosition();
    const map: Record<TooltipPosition, ConnectedPosition[]> = {
      top: [
        {
          originX: 'center',
          originY: 'top',
          overlayX: 'center',
          overlayY: 'bottom',
          offsetY: -6,
        },
      ],
      bottom: [
        {
          originX: 'center',
          originY: 'bottom',
          overlayX: 'center',
          overlayY: 'top',
          offsetY: 6,
        },
      ],
      left: [
        {
          originX: 'start',
          originY: 'center',
          overlayX: 'end',
          overlayY: 'center',
          offsetX: -6,
        },
      ],
      right: [
        {
          originX: 'end',
          originY: 'center',
          overlayX: 'start',
          overlayY: 'center',
          offsetX: 6,
        },
      ],
    };
    return map[pos];
  }
}
