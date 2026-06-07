"use client";
import { useState, FormEvent, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card } from "@/app/components/Card";
import { Button } from "@/app/components/Button";
import { Input } from "@/app/components/Input";
import { FormError } from "@/app/components/FormError";
import { CheckCircle, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface UserInfo {
  id: string;
  username: string;
  role: string;
}

export default function UserDetailPage() {
  const params = useParams<{ userId: string }>();
  const router = useRouter();
  const userId = params.userId;

  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Fetch user info from the list endpoint
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((users: UserInfo[]) => {
        const found = users.find((u) => u.id === userId) ?? null;
        setUser(found);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 8) {
      setError("Passwort muss mindestens 8 Zeichen lang sein.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwörter stimmen nicht überein.");
      return;
    }

    setSaving(true);
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });

    if (res.ok) {
      setSuccess(true);
      setNewPassword("");
      setConfirmPassword("");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Fehler beim Speichern.");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto px-4 py-6 max-w-md">
      <div className="flex items-center gap-3">
        <Link href="/admin/users" className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-bold">
          {loading ? "Konto" : (user?.username ?? "Konto nicht gefunden")}
        </h1>
      </div>

      {!loading && !user && (
        <p className="text-[var(--foreground-muted)]">Benutzer nicht gefunden.</p>
      )}

      {user && (
        <Card>
          <h2 className="font-semibold mb-1">Passwort zurücksetzen</h2>
          <p className="text-sm text-[var(--foreground-muted)] mb-4">
            Als Admin kannst du das Passwort direkt setzen — kein altes Passwort nötig.
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Neues Passwort</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Mindestens 8 Zeichen</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Passwort bestätigen</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>

            <FormError message={error} />

            {success && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-unlock)] bg-[var(--color-unlock-bg)] border border-[var(--color-unlock-border)] rounded-xl px-3 py-2">
                <CheckCircle className="h-4 w-4 shrink-0" />
                Passwort erfolgreich gesetzt.
              </div>
            )}

            <div className="flex gap-2">
              <Button type="submit" loading={saving} className="flex-1">
                Passwort setzen
              </Button>
              <Button type="button" variant="secondary" onClick={() => router.push("/admin/users")}>
                Abbrechen
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
