/**
 * Re-export wrapper. The actual parser lives in `src-main/shared/` so
 * the skill-registry feature can consume it without crossing the
 * skills-feature boundary. Kept here for import stability — existing
 * `./frontmatter` imports inside this feature keep working unchanged.
 */
export {
  parseSkillFrontmatter as parseFrontmatter,
  type SkillFrontmatter,
} from '../../../shared/skill-frontmatter';
