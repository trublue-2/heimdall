import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Lock, Activity, Settings, Users, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect("/login");

  const role = (session.user as { role?: string }).role;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Lock className="h-5 w-5 text-[var(--color-lock)]" />
            <span className="font-semibold">Heimdall</span>
          </div>
          <nav className="flex items-center gap-1">
            <Link href="/dashboard" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Status
            </Link>
            <Link href="/dashboard/policy" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Policy
            </Link>
            <Link href="/dashboard/events" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Events
            </Link>
            {role === "admin" && (
              <>
                <Link href="/dashboard/devices/new" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                  Gerät +
                </Link>
                <Link href="/admin/users" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                  Konten
                </Link>
              </>
            )}
            <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
              <button type="submit" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                Abmelden
              </button>
            </form>
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
