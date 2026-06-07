"use client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/app/components/Button";
import { useState } from "react";
import { KeyRound } from "lucide-react";

export function UserActions({ userId, username }: { userId: string; username: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Konto "${username}" wirklich löschen?`)) return;
    setDeleting(true);
    await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    router.refresh();
    setDeleting(false);
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/admin/users/${userId}`}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] hover:bg-[var(--border-subtle)] text-[var(--foreground)] font-medium transition-colors"
      >
        <KeyRound className="h-3 w-3" />
        PW setzen
      </Link>
      <Button variant="danger" onClick={handleDelete} loading={deleting} className="text-xs px-2 py-1">
        Löschen
      </Button>
    </div>
  );
}
