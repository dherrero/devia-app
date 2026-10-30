import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

const MAX_SUGGESTIONS = 5;
const FALLBACK_SPELLCHECK_LANGUAGES = ['es-ES', 'en-US'];

export type ContextMenuInput = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>;

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
}

/**
 * Electron ships no default context menu, so without this the spellchecker
 * underlines words but right-click offers no way to fix them.
 */
export function buildContextMenuTemplate(
  params: ContextMenuInput,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) {
      items.push({ label: 'Sin sugerencias', enabled: false });
    }
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    const word = params.misspelledWord;
    items.push(
      { label: 'Añadir al diccionario', click: () => actions.addToDictionary(word) },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    items.push(
      { label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Seleccionar todo', role: 'selectAll', enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ label: 'Copiar', role: 'copy' });
  }

  while (items.at(-1)?.type === 'separator') items.pop();
  return items;
}

/**
 * Picks Hunspell dictionaries from the OS languages. Only meaningful on
 * Windows/Linux: macOS uses the native NSSpellChecker, which ignores this and
 * detects the language on its own.
 */
export function pickSpellCheckerLanguages(preferred: readonly string[], available: readonly string[]): string[] {
  const byLower = new Map(available.map((code) => [code.toLowerCase(), code]));
  const picked = new Set<string>();
  for (const lang of preferred) {
    const lower = lang.toLowerCase();
    const exact = byLower.get(lower);
    const base = lower.split('-')[0] ?? lower;
    const match = exact ?? byLower.get(base) ?? available.find((code) => code.toLowerCase().startsWith(`${base}-`));
    if (match) picked.add(match);
  }
  if (picked.size === 0) {
    for (const code of FALLBACK_SPELLCHECK_LANGUAGES) if (byLower.has(code.toLowerCase())) picked.add(code);
  }
  return [...picked];
}

export function installContextMenu(win: BrowserWindow): void {
  const contents = win.webContents;
  contents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
