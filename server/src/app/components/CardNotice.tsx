/** Hinweiszeile innerhalb einer Karte — die Warn-Optik (Farbtripel + Rahmen) stand sonst je Anlass
 *  neu ausgeschrieben da. `tone="warn"` für alles, was zu einer Öffnung führt, `tone="muted"` für
 *  einen Hinweis, der (noch) keine Handlung erzwingt. Bewusst KEIN Icon-Prop: die Zeilen setzen ihr
 *  Zeichen selbst in den Text, damit „⚠" nicht bei jedem neutralen Hinweis mitkommt. */
export function CardNotice({ tone, children }: { tone: "warn" | "muted"; children: React.ReactNode }) {
  const style =
    tone === "warn"
      ? "bg-[var(--color-warn-bg)] border-[var(--color-warn-border)] text-[var(--color-warn)]"
      : "bg-[var(--surface-raised)] border-[var(--border)] text-[var(--foreground-muted)]";
  return <div className={`mx-4 mb-3 rounded-xl border px-3 py-2 text-xs flex items-center gap-1.5 ${style}`}>{children}</div>;
}
