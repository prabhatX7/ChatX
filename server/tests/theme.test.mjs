import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_THEME, normalizeTheme } from '../src/services/theme.js';

test('two colours, purple by default', () => {
  assert.deepEqual(THEMES, ['purple', 'blue']);
  assert.equal(DEFAULT_THEME, 'purple');
});

test('anything that is not a known colour becomes purple', () => {
  assert.equal(normalizeTheme('blue'), 'blue');
  assert.equal(normalizeTheme('purple'), 'purple');
  for (const bad of [undefined, null, '', 'neon', 'normal', 'red', {}, ['blue']]) assert.equal(normalizeTheme(bad), 'purple');
});
