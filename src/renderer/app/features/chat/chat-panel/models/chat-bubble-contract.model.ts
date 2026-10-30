import type {
  ChatMessage,
  ContentBlock,
  MessageUsage,
  ToolCallRecord,
} from '../../../../../../shared/domain/chat';

/**
 * Desktop adapter contract for the reusable chat bubble components.
 *
 * Keep the future component library coupled to this view contract, not to the
 * desktop chat domain directly. The current renderer can keep its existing
 * implementation until the component definitions are ready, then swap the
 * template to the library inputs without reshaping every call site.
 */
export type ChatBubbleMessage = ChatMessage;
export type ChatBubbleContentBlock = ContentBlock;
export type ChatBubbleToolCall = ToolCallRecord;
export type ChatBubbleUsage = MessageUsage;

export interface ChatBubbleActions {
  retry(): void;
  copyText(text: string): Promise<void>;
  openPath(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  openInIde(path: string): Promise<void>;
  focusDiffFile(path: string): void;
}
