import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";
import { handleSignOut } from "@/lib/actions";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const role = (session?.user as { role?: string })?.role;
  if (!session || role !== "admin") redirect("/dashboard");

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Lock className="h-5 w-5 text-[var(--color-lock)]" />
            <span className="font-semibold">Heimdall</span>
            <span className="text-xs text-[var(--foreground-muted)] bg-[var(--surface-raised)] rounded px-2 py-0.5">Admin</span>
          </div>
          <nav className="flex items-center gap-1">
            <Link href="/dashboard" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Dashboard
            </Link>
            <Link href="/admin/users" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
              Konten
            </Link>
            <form action={handleSignOut}>
              <button type="submit" className="px-3 py-1.5 text-sm rounded-lg hover:bg-[var(--surface-raised)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
                Abmelden
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
