/** Checkbox-Toggle mit Titel + Beschreibung. Geteilt von den Geräte-Einstellungen
 *  (OTA-Freeze, Debug-Mode) und dem Server-Log-Schalter. */
export function Toggle({ checked, onChange, title, desc }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-[var(--color-warn)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {title}
        <span className="block text-xs text-[var(--foreground-faint)]">{desc}</span>
      </span>
    </label>
  );
}
