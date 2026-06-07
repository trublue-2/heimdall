"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/app/components/Button";
import { useState } from "react";

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
    <Button variant="danger" onClick={handleDelete} loading={deleting} className="text-xs px-2 py-1">
      Löschen
    </Button>
  );
}
