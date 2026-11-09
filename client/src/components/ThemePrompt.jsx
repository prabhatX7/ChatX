import { useState } from 'react';
import { createPortal } from 'react-dom';
import ThemePicker from './ThemePicker.jsx';

/** Shown once, right after someone's first sign-up / login: which colour do they like? (Changeable later in Settings.) */
export default function ThemePrompt({ initial, onPreview, onDone }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  const pick = (t) => {
    setValue(t);
    onPreview(t); // the whole app changes colour right behind the popup
  };

  async function save() {
    setBusy(true);
    try {
      await onDone(value);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-back">
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Pick your colour">
        <h3>Pick your colour</h3>
        <p className="muted small-text">Both have a little neon. You can change it any time in Settings.</p>
        <ThemePicker value={value} onChange={pick} name="first-theme" />
        <div className="modal-actions">
          <button className="btn primary" onClick={save} disabled={busy} autoFocus>
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
