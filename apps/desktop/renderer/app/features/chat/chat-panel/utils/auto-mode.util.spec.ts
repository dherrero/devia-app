import { describe, expect, it } from 'vitest';
import { detectModeIntent, detectsApplyIntent, detectsPlanIntent } from './auto-mode.util';

describe('detectsPlanIntent', () => {
  it('detects "plan" as the first word, case-insensitively', () => {
    expect(detectsPlanIntent('plan')).toBe(true);
    expect(detectsPlanIntent('Plan el refactor del módulo')).toBe(true);
    expect(detectsPlanIntent('  PLAN esto  ')).toBe(true);
  });

  it('detects the plan/planifica/planea family (es)', () => {
    expect(detectsPlanIntent('planifica la migración')).toBe(true);
    expect(detectsPlanIntent('Planea los siguientes pasos')).toBe(true);
  });

  it('detects "analiza"/"analízame"/"análisis" ignoring diacritics (es)', () => {
    expect(detectsPlanIntent('analiza el bug')).toBe(true);
    expect(detectsPlanIntent('Analízame este componente')).toBe(true);
    expect(detectsPlanIntent('análisis del rendimiento')).toBe(true);
  });

  it('detects English/French/German plan & analyze verbs', () => {
    expect(detectsPlanIntent('analyze the failure')).toBe(true); // en
    expect(detectsPlanIntent('analyse this module')).toBe(true); // en/fr
    expect(detectsPlanIntent('Planifie la migration')).toBe(true); // fr
    expect(detectsPlanIntent('Analysiere den Fehler')).toBe(true); // de
    expect(detectsPlanIntent('Plane das Refactoring')).toBe(true); // de
  });

  it('detects Italian / Portuguese / Catalan verbs', () => {
    expect(detectsPlanIntent('pianifica la migrazione')).toBe(true); // it
    expect(detectsPlanIntent('analizza il bug')).toBe(true); // it
    expect(detectsPlanIntent('planeja a migração')).toBe(true); // pt
    expect(detectsPlanIntent('analisa o erro')).toBe(true); // pt
    expect(detectsPlanIntent('analitza el component')).toBe(true); // ca
  });

  it('detects Russian / Hindi / Arabic / Chinese verbs', () => {
    expect(detectsPlanIntent('Проанализируй ошибку')).toBe(true); // ru
    expect(detectsPlanIntent('Спланируй la tarea')).toBe(true); // ru
    expect(detectsPlanIntent('योजना बनाओ')).toBe(true); // hi
    expect(detectsPlanIntent('विश्लेषण करो')).toBe(true); // hi
    expect(detectsPlanIntent('حلل الخطأ')).toBe(true); // ar
    expect(detectsPlanIntent('خطط للمشروع')).toBe(true); // ar
    expect(detectsPlanIntent('分析这个错误')).toBe(true); // zh (no spaces)
    expect(detectsPlanIntent('计划重构')).toBe(true); // zh
  });

  it('only inspects the leading word (space scripts)', () => {
    expect(detectsPlanIntent('arregla el plan de pruebas')).toBe(false);
    expect(detectsPlanIntent('fix the analysis later')).toBe(false);
  });

  it('returns false for unrelated or empty input', () => {
    expect(detectsPlanIntent('')).toBe(false);
    expect(detectsPlanIntent('   ')).toBe(false);
    expect(detectsPlanIntent('refactoriza el servicio')).toBe(false);
    expect(detectsPlanIntent('fix the login bug')).toBe(false);
  });
});

describe('detectsApplyIntent', () => {
  it('detects "ejecuta"/"aplica"/"implementa"/"hazlo" (es)', () => {
    expect(detectsApplyIntent('ejecuta')).toBe(true);
    expect(detectsApplyIntent('Ejecútalo ya')).toBe(true);
    expect(detectsApplyIntent('aplica los cambios')).toBe(true);
    expect(detectsApplyIntent('implementa la feature')).toBe(true);
    expect(detectsApplyIntent('Hazlo ahora')).toBe(true);
    expect(detectsApplyIntent('realiza los cambios')).toBe(true);
    expect(detectsApplyIntent('lanza la migración')).toBe(true);
  });

  it('detects English execute/run/apply/implement verbs', () => {
    expect(detectsApplyIntent('execute the plan')).toBe(true);
    expect(detectsApplyIntent('run it')).toBe(true);
    expect(detectsApplyIntent('apply the changes')).toBe(true);
    expect(detectsApplyIntent('implement the feature')).toBe(true);
    expect(detectsApplyIntent('proceed with it')).toBe(true);
  });

  it('detects FR/DE/IT/PT/CA execute verbs (diacritics ignored)', () => {
    expect(detectsApplyIntent('Exécute le plan')).toBe(true); // fr
    expect(detectsApplyIntent('Applique les changements')).toBe(true); // fr
    expect(detectsApplyIntent('Implémente la fonctionnalité')).toBe(true); // fr
    expect(detectsApplyIntent('Führe das aus')).toBe(true); // de
    expect(detectsApplyIntent('Mach es')).toBe(true); // de
    expect(detectsApplyIntent('esegui il piano')).toBe(true); // it
    expect(detectsApplyIntent('applica le modifiche')).toBe(true); // it
    expect(detectsApplyIntent('executa o plano')).toBe(true); // pt
    expect(detectsApplyIntent('faça as alterações')).toBe(true); // pt
    expect(detectsApplyIntent('executa el pla')).toBe(true); // ca
  });

  it('detects Russian / Hindi / Arabic / Chinese execute verbs', () => {
    expect(detectsApplyIntent('Выполни la tarea')).toBe(true); // ru
    expect(detectsApplyIntent('Примени los cambios')).toBe(true); // ru
    expect(detectsApplyIntent('Запусти esto')).toBe(true); // ru
    expect(detectsApplyIntent('चलाओ अब')).toBe(true); // hi
    expect(detectsApplyIntent('लागू करो')).toBe(true); // hi
    expect(detectsApplyIntent('نفذ الخطة')).toBe(true); // ar
    expect(detectsApplyIntent('طبق التغييرات')).toBe(true); // ar
    expect(detectsApplyIntent('执行这个计划')).toBe(true); // zh
    expect(detectsApplyIntent('运行它')).toBe(true); // zh
  });

  it('only inspects the leading word, and ignores plan/analysis verbs', () => {
    expect(detectsApplyIntent('arregla y ejecuta el test')).toBe(false);
    expect(detectsApplyIntent('planifica la migración')).toBe(false);
    expect(detectsApplyIntent('analiza el bug')).toBe(false);
  });

  it('returns false for unrelated or empty input', () => {
    expect(detectsApplyIntent('')).toBe(false);
    expect(detectsApplyIntent('   ')).toBe(false);
    expect(detectsApplyIntent('refactoriza el servicio')).toBe(false);
    expect(detectsApplyIntent('arregla el login')).toBe(false);
  });
});

describe('detectModeIntent', () => {
  it('maps a plan-intent message to "plan"', () => {
    expect(detectModeIntent('planifica la migración')).toBe('plan');
    expect(detectModeIntent('analiza el bug')).toBe('plan');
    expect(detectModeIntent('plan the refactor')).toBe('plan');
  });

  it('maps an apply-intent message to "apply"', () => {
    expect(detectModeIntent('ejecuta los tests')).toBe('apply');
    expect(detectModeIntent('aplica los cambios')).toBe('apply');
    expect(detectModeIntent('run it')).toBe('apply');
  });

  it('returns null when no intent is signalled', () => {
    expect(detectModeIntent('')).toBeNull();
    expect(detectModeIntent('refactoriza el servicio')).toBeNull();
    expect(detectModeIntent('arregla el login')).toBeNull();
  });

  it('gives plan precedence when the leading word is a plan verb', () => {
    expect(detectModeIntent('planifica y aplica los cambios')).toBe('plan');
  });
});
