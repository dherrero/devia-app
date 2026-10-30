import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'dv-chat-inline-code',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'dv-chat-inline-code',
  },
})
export class DvChatInlineCodeComponent {}
