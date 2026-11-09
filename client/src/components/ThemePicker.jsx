// Two colour cards: purple or blue (both with a little neon). Used in the first-time popup and in Settings.
export default function ThemePicker({ value, onChange, name = 'theme' }) {
  const opts = [
    { id: 'purple', title: 'Purple', sub: 'A little neon' },
    { id: 'blue', title: 'Blue', sub: 'A little neon' },
  ];
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Colour">
      {opts.map((o) => (
        <label key={o.id} className={`theme-card theme-${o.id} ${value === o.id ? 'on' : ''}`}>
          <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
          <span className="theme-swatch" aria-hidden="true" />
          <span className="theme-title">{o.title}</span>
          <span className="muted small-text">{o.sub}</span>
        </label>
      ))}
    </div>
  );
}
