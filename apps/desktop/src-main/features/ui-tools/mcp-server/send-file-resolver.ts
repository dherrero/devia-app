import {
  UI_LIMITS,
  normalizeSendFileInput,
  type SendFileAs,
  type SendFileRequest,
} from '../../../../shared/domain/ui-tools';
import { MAX_PHOTO_BYTES } from '../../../../shared/domain/outbound-file-policy';
import { checkOutboundFile, formatBytes } from '../../../shared/outbound-file-guard';
import type { UiLocalResolution } from './ui-tools-call';

/**
 * `devia_send_file` (S-32) validated INSIDE the MCP server, before the
 * rendezvous. The tool is fire-and-forget, so a refusal noticed only by the
 * main process would never reach the agent — it would believe the file went
 * out. The main process still revalidates (the request file is not trusted).
 *
 * One server process = one run, so the counter is per run.
 */
export interface SendFileResolverOptions {
  /** Absolute run cwd (explicit argv: some agents spawn the server elsewhere). */
  cwd: string | null;
  /** Absolute folders files may be sent from. */
  roots: readonly string[];
  /** Folders nothing may be sent from even inside a root (Devia's data dir). */
  denyRoots?: readonly string[];
  /** Override for tests; the guard defaults to `os.homedir()`. */
  homeDir?: string;
  limit?: number;
}

export function makeSendFileResolver(
  options: SendFileResolverOptions,
): (tool: string, args: unknown) => Promise<UiLocalResolution> {
  const limit = options.limit ?? UI_LIMITS.sendFilesPerRun;
  let queued = 0;

  return async (tool, args) => {
    if (tool !== 'send_file') return null;
    if (!options.cwd || options.roots.length === 0) {
      return error('devia_send_file is not configured for this run (no allowed folders). Tell the user the file could not be sent.');
    }

    const input = normalizeSendFileInput(args);
    if (input === null) {
      return error('Expected { path: string, caption?: string, as?: "auto" | "document" | "photo" }.');
    }
    if (queued >= limit) {
      return error(`Limit reached: at most ${limit} files can be sent per run. Pick the most relevant ones, or zip several into one archive.`);
    }

    const check = checkOutboundFile({
      requestedPath: input.path,
      cwd: options.cwd,
      roots: options.roots,
      ...(options.denyRoots !== undefined && { denyRoots: options.denyRoots }),
      ...(options.homeDir !== undefined && { homeDir: options.homeDir }),
    });
    if (!check.ok) return error(check.message);

    // Telegram refuses photos over its photo cap; a document still arrives.
    const as: SendFileAs = input.as === 'photo' && check.size > MAX_PHOTO_BYTES ? 'document' : input.as;
    const request: SendFileRequest & { path: string } = {
      path: input.path,
      absPath: check.absPath,
      name: check.name,
      size: check.size,
      mime: check.mime,
      as,
      ...(input.caption !== undefined && { caption: input.caption }),
    };
    queued++;
    return {
      passThrough: request,
      ack: `Queued: ${check.name} (${formatBytes(check.size)}) will be sent to the user's chat after your reply. Do not paste its content.`,
    };
  };
}

function error(text: string): UiLocalResolution {
  return { text, isError: true };
}
