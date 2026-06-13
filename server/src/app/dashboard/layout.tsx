import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { AvatarMenu } from "@/app/components/AvatarMenu";
import pkg from "../../../package.json";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");

  const user = session.user as { role?: string; name?: string };
  const isAdmin = user.role === "admin";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-3">
            <Lock className="h-5 w-5 text-[var(--color-lock)]" />
            <span className="font-semibold">Heimdall</span>
            <span className="text-xs text-[var(--foreground-faint)] font-mono">
              v{pkg.version}{process.env.APP_BUILD && process.env.APP_BUILD !== "dev" ? `.${process.env.APP_BUILD}` : ""}
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link href="/dashboard" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Dashboard
            </Link>
            {isAdmin && (
              <Link href="/dashboard/geraete" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                Geräte
              </Link>
            )}
            {isAdmin && (
              <Link href="/dashboard/konten" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                Konten
              </Link>
            )}
            {isAdmin && (
              <Link href="/dashboard/tracker" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                Tracker
              </Link>
            )}
            <div className="pl-2">
              <AvatarMenu username={user.name ?? "?"} />
            </div>
          </nav>
        </div>
      </header>

      <main className="flex-1 px-4 py-6">
        <div className="max-w-4xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
