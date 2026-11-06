/**
 * The text a kit adds to the system prompt of every agent (S-39): its bootstrap
 * skill and an index of its skills. Nothing else — the skills already speak
 * Devia's tools, so there is no table translating them. It sits in the cached
 * prompt prefix on every turn, so it stays small (a test holds the line).
 */
export interface KitManifestSkill {
  name: string;
  origin: 'literal' | 'derived' | 'own';
  trigger: string;
}

export interface KitManifest {
  id: string;
  name: string;
  version: string;
  bootstrap: string;
  upstream: { repo: string; tag: string; commit: string };
  skills: KitManifestSkill[];
}

export function parseKitManifest(raw: string): KitManifest | null {
  try {
    const m = JSON.parse(raw) as Partial<KitManifest>;
    if (typeof m.id !== 'string' || typeof m.name !== 'string' || typeof m.version !== 'string' || typeof m.bootstrap !== 'string') return null;
    if (!m.upstream || typeof m.upstream.tag !== 'string' || !Array.isArray(m.skills)) return null;
    const skills = m.skills.filter(
      (s): s is KitManifestSkill => !!s && typeof s.name === 'string' && typeof s.trigger === 'string' && ['literal', 'derived', 'own'].includes(s.origin),
    );
    return { id: m.id, name: m.name, version: m.version, bootstrap: m.bootstrap, upstream: m.upstream as KitManifest['upstream'], skills };
  } catch {
    return null;
  }
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

export function buildKitPrompt(manifest: KitManifest, bootstrapMarkdown: string, skillsDir: string): string {
  const index = manifest.skills
    .filter((s) => s.name !== manifest.bootstrap)
    .map((s) => `- \`${s.name}\`: ${s.trigger}`)
    .join('\n');
  return [
    `## ${manifest.name}`,
    '',
    `This is the \`${manifest.bootstrap}\` skill, already loaded; do not load it again. The skills live in \`${skillsDir}\`.`,
    '',
    stripFrontmatter(bootstrapMarkdown),
    '',
    '## Skills',
    '',
    index,
  ].join('\n');
}
