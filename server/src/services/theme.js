// Each person picks a colour once (a popup after their first sign-up / login) and can change it in Settings.
export const THEMES = ['purple', 'blue'];
export const DEFAULT_THEME = 'purple';
export const normalizeTheme = (t) => (THEMES.includes(t) ? t : DEFAULT_THEME);
