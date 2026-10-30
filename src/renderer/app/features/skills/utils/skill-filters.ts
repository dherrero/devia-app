import type { DiscoveredSkill, InstalledSkill } from '../../../../types/devia';

/** Case-insensitive substring match against name + description. */
export function filterInstalled(list: InstalledSkill[], query: string): InstalledSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q),
  );
}

export function filterDiscovered(list: DiscoveredSkill[], query: string): DiscoveredSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q),
  );
}

export function installedKey(s: InstalledSkill): string {
  return `${s.scope}::${s.absolutePath}`;
}
