/**
 * IDE catalog + pure launch helpers, shared between the main process (which
 * detects installed IDEs and spawns them) and the renderer (which renders the
 * "open in IDE" selector). No Node.js APIs here — real detection and spawning
 * live in `src-main/features/shell/ide.ts`.
 */

export type IdeId =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'zed'
  | 'sublime'
  | 'intellij'
  | 'webstorm'
  | 'pycharm'
  | 'android-studio'
  | 'xcode';

export type OsKind = 'mac' | 'win' | 'linux';

/** Minimal shape the renderer needs to render one entry of the selector. */
export interface IdeInfo {
  id: IdeId;
  label: string;
}

/**
 * Per-OS launch handles for one IDE, in preference order (first match wins):
 * - `mac`: macOS `.app` bundle names, opened via `open -a "<name>"`.
 * - `win` / `linux`: CLI commands resolved on PATH (`where` / `which`) and
 *   spawned directly.
 */
export interface IdeSpec {
  id: IdeId;
  label: string;
  mac: readonly string[];
  win: readonly string[];
  linux: readonly string[];
}

export const IDE_CATALOG: readonly IdeSpec[] = [
  { id: 'vscode',         label: 'VS Code',        mac: ['Visual Studio Code'],                 win: ['code'],                   linux: ['code'] },
  { id: 'cursor',         label: 'Cursor',         mac: ['Cursor'],                             win: ['cursor'],                 linux: ['cursor'] },
  { id: 'windsurf',       label: 'Windsurf',       mac: ['Windsurf'],                           win: ['windsurf'],               linux: ['windsurf'] },
  { id: 'zed',            label: 'Zed',            mac: ['Zed'],                                win: ['zed'],                    linux: ['zed', 'zeditor'] },
  { id: 'sublime',        label: 'Sublime Text',   mac: ['Sublime Text'],                       win: ['subl'],                   linux: ['subl', 'sublime_text'] },
  { id: 'intellij',       label: 'IntelliJ IDEA',  mac: ['IntelliJ IDEA', 'IntelliJ IDEA CE'],  win: ['idea', 'idea64'],         linux: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community'] },
  { id: 'webstorm',       label: 'WebStorm',       mac: ['WebStorm'],                           win: ['webstorm', 'webstorm64'], linux: ['webstorm'] },
  { id: 'pycharm',        label: 'PyCharm',        mac: ['PyCharm', 'PyCharm CE'],              win: ['pycharm', 'pycharm64'],   linux: ['pycharm', 'pycharm-professional', 'pycharm-community'] },
  { id: 'android-studio', label: 'Android Studio', mac: ['Android Studio'],                     win: ['studio64', 'studio'],     linux: ['studio.sh', 'android-studio', 'studio'] },
  { id: 'xcode',          label: 'Xcode',          mac: ['Xcode'],                              win: [],                         linux: [] },
];

/** Launch-handle candidates for the given OS, in preference order. */
export function ideCandidates(spec: IdeSpec, os: OsKind): readonly string[] {
  if (os === 'mac') return spec.mac;
  if (os === 'win') return spec.win;
  return spec.linux;
}

/** Wrap a Windows command-line argument in quotes when it contains whitespace. */
function quoteWinArg(arg: string): string {
  if (!/\s/.test(arg) || (arg.startsWith('"') && arg.endsWith('"'))) return arg;
  return `"${arg}"`;
}

export interface IdeSpawn {
  cmd: string;
  args: string[];
  useShell: boolean;
  /** macOS `open` yields an exit code worth waiting on; PATH CLIs detach. */
  waitForExit: boolean;
}

/**
 * Build the spawn descriptor that opens `projectPath` with a resolved launch
 * handle (`.app` name on macOS, PATH command on win/linux). Pure — the shell
 * feature performs the real spawn.
 */
export function buildIdeSpawn(launch: string, projectPath: string, os: OsKind): IdeSpawn {
  if (os === 'mac') {
    return { cmd: '/usr/bin/open', args: ['-a', launch, projectPath], useShell: false, waitForExit: true };
  }
  if (os === 'win') {
    return { cmd: launch, args: [quoteWinArg(projectPath)], useShell: true, waitForExit: false };
  }
  return { cmd: launch, args: [projectPath], useShell: false, waitForExit: false };
}

/**
 * Filter the catalog to the IDEs whose detection resolved to a launch handle
 * (`id → handle`, or `null`/absent when not installed). Catalog order is
 * preserved so the selector is stable.
 */
export function availableIdes(resolved: Partial<Record<IdeId, string | null>>): IdeInfo[] {
  return IDE_CATALOG
    .filter((spec) => {
      const handle = resolved[spec.id];
      return typeof handle === 'string' && handle.length > 0;
    })
    .map((spec) => ({ id: spec.id, label: spec.label }));
}
