import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AttachmentsBarComponent } from './attachments-bar.component';
import type { PendingAttachment } from '../../models/pending-attachment.model';

function makeAtt(id: string, name = `${id}.png`): PendingAttachment {
  return {
    id,
    name,
    mime: 'image/png',
    blob: new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
    previewUrl: `blob://fake/${id}`,
    kind: 'image',
    size: 2,
  };
}

function makeFile(id: string, name: string, size: number): PendingAttachment {
  return {
    id,
    name,
    mime: 'application/octet-stream',
    blob: new Blob([new Uint8Array(size)]),
    previewUrl: null,
    kind: 'binary',
    size,
  };
}

describe('AttachmentsBarComponent (HT-CH-04)', () => {
  let fixture: ComponentFixture<AttachmentsBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AttachmentsBarComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(AttachmentsBarComponent);
    fixture.componentRef.setInput('items', []);
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders nothing when items is empty', () => {
    expect(el().querySelectorAll('.ds-attachments-bar__chip').length).toBe(0);
  });

  it('renders one chip per item with name + thumbnail and remove button', () => {
    fixture.componentRef.setInput('items', [makeAtt('a'), makeAtt('b', 'b.jpg')]);
    fixture.detectChanges();
    const chips = el().querySelectorAll<HTMLElement>('.ds-attachments-bar__chip');
    expect(chips.length).toBe(2);
    expect(chips[0].querySelector('.ds-attachments-bar__name')?.textContent?.trim()).toBe('a.png');
    expect(
      (chips[0].querySelector('.ds-attachments-bar__thumb') as HTMLElement).style.backgroundImage,
    ).toContain('blob://fake/a');
    expect(chips[1].querySelector('.ds-attachments-bar__name')?.textContent?.trim()).toBe('b.jpg');
  });

  it('renders a non-image as a file icon with its size instead of a thumbnail', () => {
    fixture.componentRef.setInput('items', [makeFile('f', 'dump.sqlite', 2048)]);
    fixture.detectChanges();
    const chip = el().querySelector('.ds-attachments-bar__chip') as HTMLElement;
    expect(chip.querySelector('.ds-attachments-bar__thumb')).toBeNull();
    expect(chip.querySelector('.ds-attachments-bar__file')).not.toBeNull();
    expect(chip.querySelector('.ds-attachments-bar__size')?.textContent?.trim()).toBe('2.0 KB');
  });

  it('emits the id when the user clicks the remove button', () => {
    fixture.componentRef.setInput('items', [makeAtt('a'), makeAtt('b')]);
    fixture.detectChanges();
    let received: string | null = null;
    fixture.componentInstance.removed.subscribe((id) => (received = id));
    const buttons = el().querySelectorAll<HTMLButtonElement>('.ds-attachments-bar__chip dv-button button');
    buttons[1].click();
    expect(received).toBe('b');
  });

  it('attaches the name as title attribute (truncated names stay reachable)', () => {
    fixture.componentRef.setInput('items', [makeAtt('a', 'really_long_name_that_truncates.png')]);
    fixture.detectChanges();
    const chip = el().querySelector('.ds-attachments-bar__chip') as HTMLElement;
    expect(chip.getAttribute('title')).toBe('really_long_name_that_truncates.png');
  });
});
