import { ReactNode } from "react";

type BadgeVariant = "lock" | "unlock" | "warn" | "neutral";

const styles: Record<BadgeVariant, string> = {
  lock: "bg-[var(--color-lock-bg)] text-[var(--color-lock-text)] border-[var(--color-lock-border)]",
  unlock: "bg-[var(--color-unlock-bg)] text-[var(--color-unlock-text)] border-[var(--color-unlock-border)]",
  warn: "bg-[var(--color-warn-bg)] text-[var(--color-warn-text)] border-[var(--color-warn-border)]",
  neutral: "bg-[var(--surface-raised)] text-[var(--foreground-muted)] border-[var(--border)]",
};

export function Badge({ children, variant = "neutral" }: { children: ReactNode; variant?: BadgeVariant }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[variant]}`}>
      {children}
    </span>
  );
}
