"use client";

import { useState } from "react";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { formatDateTime, EVENT_CONFIG } from "@/lib/utils";

type Ev = { id: string; type: string; reason: string | null; battery: number | null; timestamp: string };

const PER_PAGE = 5;

/** Event-Verlauf, 5 pro Seite mit Paginierung (← neuer / älter →). */
export function EventLog({ events }: { events: Ev[] }) {
  const [page, setPage] = useState(0);

  if (events.length === 0) {
    return <Card className="text-center py-8 text-sm text-[var(--foreground-muted)]">Noch keine Events.</Card>;
  }

  const pages = Math.ceil(events.length / PER_PAGE);
  const slice = events.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  return (
    <div className="space-y-2">
      <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
        {slice.map((ev) => {
          const cfg = EVENT_CONFIG[ev.type] ?? { label: ev.type, variant: "neutral" as const };
          return (
            <div key={ev.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <Badge variant={cfg.variant}>{cfg.label}</Badge>
                {ev.reason && <code className="text-xs text-[var(--foreground-faint)] font-mono">{ev.reason}</code>}
                {ev.battery != null && <span className="text-xs text-[var(--foreground-faint)]">{ev.battery}%</span>}
              </div>
              <span className="text-xs text-[var(--foreground-faint)] shrink-0">{formatDateTime(ev.timestamp)}</span>
            </div>
          );
        })}
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-[var(--foreground-muted)]">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2 py-1 rounded hover:bg-[var(--surface-raised)] disabled:opacity-40"
          >
            ← Neuer
          </button>
          <span>Seite {page + 1} / {pages}</span>
          <button
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="px-2 py-1 rounded hover:bg-[var(--surface-raised)] disabled:opacity-40"
          >
            Älter →
          </button>
        </div>
      )}
    </div>
  );
}
