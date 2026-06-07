import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card } from "@/app/components/Card";
import { Badge } from "@/app/components/Badge";
import { formatDateTime } from "@/lib/utils";
import Link from "next/link";
import { UserActions } from "./UserActions";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const session = await auth();
  const role = (session?.user as { role?: string })?.role;
  if (role !== "admin") redirect("/dashboard");

  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div className="space-y-4 max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Keyholder-Konten</h1>
        <Link href="/admin/users/new" className="text-sm text-[var(--color-lock)] hover:underline">
          + Neues Konto
        </Link>
      </div>

      <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{u.username}</p>
              <p className="text-xs text-[var(--foreground-muted)]">Erstellt {formatDateTime(u.createdAt)}</p>
            </div>
            <Badge variant={u.role === "admin" ? "lock" : "neutral"}>
              {u.role === "admin" ? "Admin" : "Viewer"}
            </Badge>
            <UserActions userId={u.id} username={u.username} />
          </div>
        ))}
      </Card>
    </div>
  );
}
