export type DeviaThemeValue = 'light' | 'dark' | 'navy' | 'navy-dark';

export interface ThemeDefinition {
  id: DeviaThemeValue;
  label: string;
  group: 'violet' | 'navy';
  dark: boolean;
}

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  { id: 'light', label: 'Violet Light', group: 'violet', dark: false },
  { id: 'dark', label: 'Violet Dark', group: 'violet', dark: true },
  { id: 'navy', label: 'Navy Light', group: 'navy', dark: false },
  { id: 'navy-dark', label: 'Navy Dark', group: 'navy', dark: true },
];
