"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/app/components/Card";
import { Button } from "@/app/components/Button";
import { Input } from "@/app/components/Input";
import { FormError } from "@/app/components/FormError";

export default function NewUserPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
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
      router.push("/admin/users");
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 max-w-sm mx-auto px-4 py-6">
      <h1 className="text-xl font-bold">Neues Konto</h1>
      <Card>
        <form onSubmit={handleCreate} className="space-y-4">
          <Input id="username" label="Benutzername" required value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input id="password" label="Passwort" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
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
