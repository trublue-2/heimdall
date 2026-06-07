import { prisma } from "@/lib/prisma";
import { Card } from "@/app/components/Card";
import { Badge } from "@/app/components/Badge";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const EVENT_CONFIG: Record<string, { label: string; variant: "lock" | "unlock" | "warn" | "neutral" }> = {
  LOCKED: { label: "Verschlossen", variant: "lock" },
  UNLOCKED: { label: "Geöffnet", variant: "unlock" },
  SYNC: { label: "Sync", variant: "neutral" },
  FAILSAFE_OPEN: { label: "Failsafe-Öffnung", variant: "warn" },
  UNAUTHORIZED_OPEN: { label: "Unautorisiert geöffnet", variant: "warn" },
};

export default async function EventsPage() {
  const events = await prisma.deviceEvent.findMany({
    include: { device: { select: { name: true } } },
    orderBy: { timestamp: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Event-Log</h1>

      {events.length === 0 && (
        <Card className="text-center py-10 text-[var(--foreground-muted)] text-sm">
          Noch keine Events aufgezeichnet.
        </Card>
      )}

      <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
        {events.map((ev) => {
          const cfg = EVENT_CONFIG[ev.type] ?? { label: ev.type, variant: "neutral" as const };
          return (
            <div key={ev.id} className="flex items-start gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={cfg.variant}>{cfg.label}</Badge>
                  <span className="text-xs text-[var(--foreground-faint)]">{ev.device.name}</span>
                  {ev.reason && (
                    <code className="text-xs text-[var(--foreground-faint)] font-mono">{ev.reason}</code>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-[var(--foreground-muted)]">
                  {ev.battery != null && <span>Akku: {ev.battery} %</span>}
                  {ev.fwVersion && <span>fw {ev.fwVersion}</span>}
                </div>
              </div>
              <span className="text-xs text-[var(--foreground-faint)] whitespace-nowrap shrink-0">
                {formatDateTime(ev.timestamp)}
              </span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
