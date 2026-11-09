import { createRoot } from 'react-dom/client';
// The coding-style font, bundled with the app (no outside requests, so the strict security policy stays strict).
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import App from './App.jsx';
import { applyTheme, getSavedTheme } from './theme.js';
import './index.css';

applyTheme(getSavedTheme()); // before the first paint, so there is no flash of the wrong look

createRoot(document.getElementById('root')).render(<App />);
