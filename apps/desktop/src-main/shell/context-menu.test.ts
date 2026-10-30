import { describe, expect, it, vi } from 'vitest';
import { buildContextMenuTemplate, pickSpellCheckerLanguages, type ContextMenuInput } from './context-menu';

const allFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } as ContextMenuInput['editFlags'];

function params(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    isEditable: false,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: allFlags,
    ...overrides,
  };
}

function actions() {
  return { replaceMisspelling: vi.fn(), addToDictionary: vi.fn() };
}

describe('buildContextMenuTemplate', () => {
  it('offers suggestions, add-to-dictionary and edit actions for a misspelled word', () => {
    const a = actions();
    const template = buildContextMenuTemplate(
      params({ isEditable: true, misspelledWord: 'ortografia', dictionarySuggestions: ['ortografía', 'ortógrafa'] }),
      a,
    );

    expect(template.map((i) => i.label ?? i.type)).toEqual([
      'ortografía', 'ortógrafa', 'Añadir al diccionario', 'separator',
      'Cortar', 'Copiar', 'Pegar', 'separator', 'Seleccionar todo',
    ]);

    template[0]!.click!({} as never, undefined, {} as never);
    expect(a.replaceMisspelling).toHaveBeenCalledWith('ortografía');
    template[2]!.click!({} as never, undefined, {} as never);
    expect(a.addToDictionary).toHaveBeenCalledWith('ortografia');
  });

  it('caps suggestions at five and says so when there are none', () => {
    const many = buildContextMenuTemplate(
      params({ misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
      actions(),
    );
    expect(many.filter((i) => i.click && i.label !== 'Añadir al diccionario')).toHaveLength(5);

    const none = buildContextMenuTemplate(params({ misspelledWord: 'asdasd' }), actions());
    expect(none[0]).toMatchObject({ label: 'Sin sugerencias', enabled: false });
  });

  it('mirrors edit flags in an editable field', () => {
    const template = buildContextMenuTemplate(
      params({ isEditable: true, editFlags: { ...allFlags, canCut: false, canCopy: false } }),
      actions(),
    );
    expect(template.find((i) => i.role === 'cut')?.enabled).toBe(false);
    expect(template.find((i) => i.role === 'paste')?.enabled).toBe(true);
  });

  it('offers only copy for selected read-only text, and nothing otherwise', () => {
    expect(buildContextMenuTemplate(params({ selectionText: 'hola' }), actions()).map((i) => i.role)).toEqual(['copy']);
    expect(buildContextMenuTemplate(params(), actions())).toEqual([]);
    expect(buildContextMenuTemplate(params({ selectionText: '   ' }), actions())).toEqual([]);
  });

  it('never ends on a separator', () => {
    const template = buildContextMenuTemplate(params({ misspelledWord: 'x', dictionarySuggestions: ['y'] }), actions());
    expect(template.at(-1)?.type).not.toBe('separator');
  });
});

describe('pickSpellCheckerLanguages', () => {
  const available = ['en-US', 'en-GB', 'es', 'es-ES', 'fr'];

  it('matches exact codes case-insensitively', () => {
    expect(pickSpellCheckerLanguages(['es-es', 'en-GB'], available)).toEqual(['es-ES', 'en-GB']);
  });

  it('falls back to the base language or any regional variant', () => {
    expect(pickSpellCheckerLanguages(['es-MX'], available)).toEqual(['es']);
    expect(pickSpellCheckerLanguages(['en-AU'], available)).toEqual(['en-US']);
  });

  it('uses es-ES / en-US when nothing matches', () => {
    expect(pickSpellCheckerLanguages(['ja-JP'], available)).toEqual(['es-ES', 'en-US']);
    expect(pickSpellCheckerLanguages(['ja-JP'], ['de'])).toEqual([]);
  });
});
