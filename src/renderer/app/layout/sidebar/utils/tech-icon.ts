/**
 * Sidebar technology badge: maps a project's detected tech to the initials
 * rendered in the `.proj-icon` chip. Backed by the shared `tech-catalog`
 * single source of truth (same data the main-process detector uses), so the
 * badge and the detection can never drift. Colours live in CSS as
 * `--dv-tech-*` tokens, applied per `[data-tech]` in the component stylesheet.
 */
export { techLabel } from '../../../../../shared/domain/tech-catalog';
