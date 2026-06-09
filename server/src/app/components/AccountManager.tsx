"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "./Card";
import { Button } from "./Button";
import { Input } from "./Input";
import { Badge } from "./Badge";
import { FormError } from "./FormError";
import { KeyRound, Trash2 } from "lucide-react";

interface U { id: string; username: string; role: string; }

export function AccountManager({ users }: { users: U[] }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      if (!res.ok) throw new Error(await res.text());
      setUsername(""); setPassword(""); setRole("viewer");
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function resetPw(u: U) {
    const pw = window.prompt(`Neues Passwort für "${u.username}" (min. 8 Zeichen):`);
    if (!pw) return;
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) { alert(await res.text()); return; }
    alert("Passwort gesetzt.");
  }

  async function remove(u: U) {
    if (!confirm(`Konto "${u.username}" wirklich löschen?`)) return;
    await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-[var(--border-subtle)] p-0 overflow-hidden">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{u.username}</p>
            </div>
            <Badge variant={u.role === "admin" ? "lock" : "neutral"}>
              {u.role === "admin" ? "Admin" : "Viewer"}
            </Badge>
            <Button variant="secondary" onClick={() => resetPw(u)} className="text-xs px-2 py-1 gap-1">
              <KeyRound className="h-3 w-3" /> PW
            </Button>
            <Button variant="danger" onClick={() => remove(u)} className="text-xs px-2 py-1 gap-1">
              <Trash2 className="h-3 w-3" /> Löschen
            </Button>
          </div>
        ))}
      </Card>

      <Card>
        <form onSubmit={create} className="space-y-3">
          <p className="text-sm font-medium">Neues Konto</p>
          <Input id="new-username" label="Benutzername" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input id="new-password" label="Passwort (min. 8 Zeichen)" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-[var(--foreground-muted)]">Rolle</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "viewer")}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <FormError message={error} />
          <Button type="submit" loading={saving}>Konto anlegen</Button>
        </form>
      </Card>
    </div>
  );
}
