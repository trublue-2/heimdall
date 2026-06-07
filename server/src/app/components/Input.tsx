import { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className = "", id, ...rest }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-[var(--foreground-muted)]">
          {label}
        </label>
      )}
      <input
        id={id}
        className={`w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-lock)] ${error ? "border-[var(--color-warn)]" : ""} ${className}`}
        {...rest}
      />
      {error && <p className="text-xs text-[var(--color-warn)]">{error}</p>}
    </div>
  );
}
