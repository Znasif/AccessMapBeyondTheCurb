/**
 * Labelled range input. Shared by the tactile panel and AudiomTactileApp,
 * which previously each carried their own copy.
 */
export function SliderField({ label, min, max, step, value, onChange }) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export default SliderField;
