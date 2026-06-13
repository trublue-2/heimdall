import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card } from "@/app/components/Card";
import { TrackerInstancesManager } from "@/app/components/TrackerInstancesManager";

export const dynamic = "force-dynamic";

export default async function TrackerPage() {
  const session = await auth();
  if ((session!.user as { role?: string }).role !== "admin") redirect("/dashboard");

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Tracker-Instanzen</h1>
      <p className="text-sm text-[var(--foreground-muted)]">
        chastitytracker.ch-Deployments, die dieser Server anspricht. Eine Box wird auf der
        Geräte-Detailseite einer Instanz zugeordnet.
      </p>
      <Card>
        <TrackerInstancesManager />
      </Card>
    </div>
  );
}
