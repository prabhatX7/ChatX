// Two colours: 'purple' (the default) and 'blue'. Both have a soft neon glow.
// The choice is kept on the account (so it follows you) and in this browser (so the page looks right before login).
const KEY = 'chatx_theme';

export const THEMES = ['purple', 'blue'];
export const normalizeTheme = (t) => (THEMES.includes(t) ? t : 'purple');

export function getSavedTheme() {
  try {
    return normalizeTheme(localStorage.getItem(KEY));
  } catch {
    return 'purple';
  }
}

export function applyTheme(theme) {
  const t = normalizeTheme(theme);
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the choice still applies until the page is closed */
  }
  return t;
}
