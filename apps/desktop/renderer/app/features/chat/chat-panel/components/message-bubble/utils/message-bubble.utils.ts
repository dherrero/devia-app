import type { ToolCallRecord } from '../../../../../../../../shared/domain/chat';
import type { ErrorClassification } from '../../../../../../../../shared/domain/agent-event';

// Extract a "HH:mm" time from a message id of the form `msg-<ms>-<rand>`.
// Returns empty string for ids that don't match (e.g. streaming placeholders).
export function timeFromId(id: string): string {
  const m = /^[a-z]+-(\d{10,})/i.exec(id);
  if (!m) return "";
  const d = new Date(parseInt(m[1], 10));
  if (isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 5);
}

/** Extract a short path/command argument from a tool call's input. */
export function toolArg(tc: ToolCallRecord): string {
  const inp = tc.input as Record<string, unknown> | null | undefined;
  if (!inp || typeof inp !== 'object') return '';
  const raw =
    (inp['file_path'] as string | undefined) ??
    (inp['path'] as string | undefined) ??
    (inp['command'] as string | undefined) ??
    '';
  if (!raw) return '';
  // Keep only the last 40 chars to avoid overflowing the progress line.
  return raw.length > 40 ? '…' + raw.slice(-40) : raw;
}

/** Map ErrorClassification to an i18n key and --dv-* severity token. */
export function errorCardMeta(ec: ErrorClassification): { titleKey: string } {
  switch (ec) {
    case 'auth':
      return { titleKey: 'error_card.auth' };
    case 'prompt-too-large':
      return { titleKey: 'error_card.prompt_too_large' };
    case 'transient':
      return { titleKey: 'error_card.transient' };
    case 'crash':
      return { titleKey: 'error_card.crash' };
    default:
      return { titleKey: 'error_card.unknown' };
  }
}
