/**
 * Single source of truth for project technologies.
 *
 * Drives BOTH sides with no duplication:
 * - main process (`FsTechDetector`) reads `markers` to detect a project's tech;
 * - renderer (sidebar badge) reads `label` to render the initials chip.
 *
 * Pure data + pure helpers only (lives in `shared/domain`, so no Node/Electron
 * imports). The `ProjectTech` union is DERIVED from this array (`as const`) so
 * the type and the catalogue can never drift apart — add an entry here and the
 * union, the detector and the badge all pick it up.
 *
 * Order matters: detection returns the FIRST marker match, so language/runtime
 * ecosystems come first (most specific), then the container marker, then the
 * `.git` VCS fallback, then the generic `folder` (no markers → never matches,
 * so it is the implicit default). In particular `typescript` (tsconfig.json)
 * precedes `node` (package.json): a TS project shows `TS`, a plain JS one `JS`.
 *
 * A marker beginning with `*.` is an extension glob (e.g. `*.csproj`), matched
 * by the detector against the project directory listing.
 */
export const TECH_CATALOG = [
  { id: 'typescript', label: 'TS', markers: ['tsconfig.json'] },
  { id: 'node', label: 'JS', markers: ['package.json'] },
  { id: 'python', label: 'PY', markers: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
  { id: 'go', label: 'GO', markers: ['go.mod'] },
  { id: 'rust', label: 'RS', markers: ['Cargo.toml'] },
  { id: 'maven', label: 'JV', markers: ['pom.xml'] },
  { id: 'gradle', label: 'GR', markers: ['build.gradle', 'settings.gradle', 'build.gradle.kts', 'settings.gradle.kts'] },
  { id: 'ruby', label: 'RB', markers: ['Gemfile'] },
  { id: 'php', label: 'PH', markers: ['composer.json'] },
  { id: 'dotnet', label: 'C#', markers: ['global.json', '*.csproj', '*.sln'] },
  { id: 'elixir', label: 'EX', markers: ['mix.exs'] },
  { id: 'deno', label: 'DN', markers: ['deno.json', 'deno.jsonc'] },
  { id: 'docker', label: 'DK', markers: ['Dockerfile', 'compose.yml', 'compose.yaml', 'docker-compose.yml'] },
  { id: 'git', label: 'GIT', markers: ['.git'] },
  { id: 'folder', label: '▸', markers: [] },
] as const;

export type TechDef = (typeof TECH_CATALOG)[number];
export type ProjectTech = TechDef['id'];

const BY_ID = new Map<ProjectTech, TechDef>(TECH_CATALOG.map((t) => [t.id, t]));
const FOLDER = TECH_CATALOG[TECH_CATALOG.length - 1] as TechDef;

export function techDef(id: ProjectTech): TechDef {
  return BY_ID.get(id) ?? FOLDER;
}

/** Initials/glyph shown in the sidebar technology badge. */
export function techLabel(id: ProjectTech): string {
  return techDef(id).label;
}
