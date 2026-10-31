/**
 * Auto run-mode detection from the user's message intent. Two symmetric,
 * opt-out behaviours, both pure so they unit-test in isolation:
 *
 * - `detectsPlanIntent` — a planning/analysis verb ("plan", "analiza",
 *   "analyse"…) switches the session to `plan` when it is NOT already there.
 * - `detectsApplyIntent` — an execution verb ("ejecuta", "run", "implement"…)
 *   switches the session to `apply`, but ONLY from `plan` (apply/yolo are left
 *   untouched — `reconcileMode` enforces that guard).
 *
 * Shared by the desktop composer and the Telegram router so both surfaces
 * follow the same rule. Multilingual: triggers across every UI language the
 * app ships (see `core/i18n/supported-languages.ts`).
 */

import type { RunMode } from './run-capabilities';

/** Lowercases and removes Latin/Cyrillic combining accents so "Analyse"/
 *  "análisis" normalise alike. Devanagari/Arabic marks are outside the
 *  stripped range and pass through untouched. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Matches a normalized message against leading-WORD prefixes (space-separated
 * scripts: Latin, Cyrillic, Devanagari, Arabic) and CJK leading substrings
 * (Chinese has no word spacing). Only the FIRST word / leading characters are
 * inspected, so a keyword buried mid-sentence never triggers.
 */
function matchesLeading(
  text: string,
  wordPrefixes: readonly string[],
  leadingSubstrings: readonly string[],
): boolean {
  const normalized = normalize(text).trim();
  if (!normalized) return false;
  const firstWord = normalized.split(/\s+/)[0] ?? '';
  if (wordPrefixes.some((prefix) => firstWord.startsWith(prefix))) return true;
  return leadingSubstrings.some((lead) => normalized.startsWith(lead));
}

// ── Plan / analyse intent ────────────────────────────────────────────────

const PLAN_INTENT_PREFIXES = [
  'plan', // es/en/ca/fr/de/pt — plan, planifica, planea, planifie, plane, planeja
  'analy', // en/fr/de — analyze, analyse, analysis, analyser, analysiere
  'anali', // es/it/pt/ca — analiza, analizza, analisa, analitza, analisi, anàlisi
  'pian', // it — piano, pianifica, pianificare
  'план', // ru — план, планируй, планировать
  'сплан', // ru — спланируй
  'анализ', // ru — анализ, анализируй
  'проанализ', // ru — проанализируй
  'योजना', // hi — plan
  'विश्लेषण', // hi — analysis/analyze
  'خط', // ar — خطة / خطط (plan/planning)
  'حلل', // ar — analyze
  'تحليل', // ar — analysis
] as const;

const PLAN_INTENT_LEADING = [
  '计划', // zh — plan
  '规划', // zh — planning
  '分析', // zh — analyze
] as const;

/** True when the message signals a plan/analysis intent in any supported
 *  language. */
export function detectsPlanIntent(text: string): boolean {
  return matchesLeading(text, PLAN_INTENT_PREFIXES, PLAN_INTENT_LEADING);
}

// ── Apply / execute intent ───────────────────────────────────────────────

const APPLY_INTENT_PREFIXES = [
  'ejecut', // es — ejecuta, ejecútalo, ejecutar
  'execut', // en/ca/pt/fr — execute, executa, executar, exécute
  'esegu', // it — esegui, eseguire
  'aplic', // es/pt/ca — aplica, aplícalo
  'appl', // en/it/fr — apply, applica, applique
  'implement', // es/en/ca/it/pt/fr/de — implementa, implement, implémente, implementiere
  'run', // en — run
  'realiz', // es/it/pt/ca — realiza, realizza, realitza
  'realis', // fr — réalise
  'proced', // es/it/fr — procede, procedi, procède
  'procee', // en — proceed
  'prossegu', // pt — prossegue
  'lanz', // es — lanza
  'lanc', // fr — lance
  'haz', // es — haz, hazlo
  'fes', // ca — fes, fes-ho
  'fai', // it — fai
  'fallo', // it — fallo (do it)
  'faz', // pt — faz
  'faca', // pt — faça
  'fais', // fr — fais (fais-le)
  'mach', // de — mach, mach es
  'fuhr', // de — führe (aus)
  'ausfuhr', // de — ausführen
  'wend', // de — wende an
  'выполн', // ru — выполни, выполнить
  'примен', // ru — примени
  'реализ', // ru — реализуй
  'сдела', // ru — сделай
  'запуст', // ru — запусти
  'चलाओ', // hi — run
  'लागू', // hi — apply
  'करो', // hi — do
  'कार्यान्वित', // hi — execute/implement
  'نفذ', // ar — execute
  'نفّذ', // ar — execute (with shadda)
  'طبق', // ar — apply
  'شغل', // ar — run
] as const;

const APPLY_INTENT_LEADING = [
  '执行', // zh — execute
  '运行', // zh — run
  '应用', // zh — apply
  '实现', // zh — implement
  '做', // zh — do
] as const;

/** True when the message signals an execute/apply intent in any supported
 *  language. The caller only acts on it while in `plan` mode. */
export function detectsApplyIntent(text: string): boolean {
  return matchesLeading(text, APPLY_INTENT_PREFIXES, APPLY_INTENT_LEADING);
}

// ── Combined intent ──────────────────────────────────────────────────────

export type ModeIntent = 'plan' | 'apply';

/**
 * The run-mode intent a message signals, or `null` when none. Plan wins over
 * apply (only the leading word is inspected, so the two never co-occur in
 * practice — the precedence is just a deterministic tie-break). Used by the
 * reactive composer detection to drive the mode switch as the user types.
 */
export function detectModeIntent(text: string): ModeIntent | null {
  if (detectsPlanIntent(text)) return 'plan';
  if (detectsApplyIntent(text)) return 'apply';
  return null;
}

/**
 * The mode a message should switch the session to, or `null` to leave it as is.
 * - plan intent → `plan`, unless already there.
 * - apply intent → `apply`, but ONLY from `plan`; `apply`/`apply-yolo` are
 *   deliberately left untouched.
 */
export function reconcileMode(current: RunMode, text: string): RunMode | null {
  const intent = detectModeIntent(text);
  if (intent === 'plan' && current !== 'plan') return 'plan';
  if (intent === 'apply' && current === 'plan') return 'apply';
  return null;
}
