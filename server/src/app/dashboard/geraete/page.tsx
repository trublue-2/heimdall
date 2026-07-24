import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DeviceManager } from "@/app/components/DeviceManager";
import { Card } from "@/app/components/Card";
import { boxLocked } from "@/lib/device-auth";
import { getTargetVersion, firmwareSize } from "@/lib/firmware";

export const dynamic = "force-dynamic";

export default async function GeraetePage() {
  const session = await auth();
  if ((session!.user as { role?: string }).role !== "admin") redirect("/dashboard");

  const [users, devices, fwVersion, fwSize] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, username: true } }),
    prisma.device.findMany({
      orderBy: { createdAt: "asc" },
      include: { users: { select: { id: true } }, policy: true },
    }),
    // Die Firmware-Karte zeigt den Heimdall-Slot — sie beschreibt, was die CI zuletzt
    // veröffentlicht hat, nicht den Sonderfall einzelner Boxen auf der Werks-Firmware.
    getTargetVersion("heimdall"),
    firmwareSize("heimdall"),
  ]);

  const now = new Date();
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Geräte</h1>
      <DeviceManager
        users={users.map((u) => ({ id: u.id, username: u.username }))}
        devices={devices.map((d) => ({
          id: d.id,
          name: d.name,
          assignedUserIds: d.users.map((u) => u.id),
          // Verschluss = Server/Token + Zuweisung eingefroren. Muss isDeviceLocked() spiegeln —
          // `effectiveLockUntil` allein übersah den Simple-Lock (zu, aber ohne Uhr).
          locked: d.locked || boxLocked(d.policy, now),
          otaTarget: d.otaTarget,
        }))}
      />

      <Card className="space-y-1">
        <p className="text-sm font-medium">Firmware</p>
        {fwSize == null ? (
          <p className="text-xs text-[var(--foreground-muted)]">Keine Firmware hinterlegt.</p>
        ) : (
          <>
            <p className="text-xs text-[var(--foreground-faint)]">
              Version {fwVersion ?? "unbekannt"} · {(fwSize / 1024).toFixed(0)} KB
            </p>
            <a
              href="/api/admin/firmware"
              download
              className="text-sm font-medium text-[var(--foreground)] hover:underline"
            >
              Firmware herunterladen
            </a>
          </>
        )}
      </Card>
    </div>
  );
}
