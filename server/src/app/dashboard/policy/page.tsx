"use client";
import { useState, useEffect } from "react";
import { Card } from "@/app/components/Card";
import { Button } from "@/app/components/Button";
import { Input } from "@/app/components/Input";
import { FormError } from "@/app/components/FormError";

interface PolicyData {
  deviceId: string;
  deviceName: string;
  lockUntil: string | null;
  offlineOpenHours: number;
  hardCapHours: number | null;
}

export default function PolicyPage() {
  const [policies, setPolicies] = useState<PolicyData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/devices")
      .then((r) => r.json())
      .then((data) => { setPolicies(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--foreground-muted)]">Lädt…</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Lock Policy</h1>
      {policies.length === 0 && (
        <p className="text-[var(--foreground-muted)] text-sm">Noch kein Gerät vorhanden.</p>
      )}
      {policies.map((p) => (
        <PolicyCard key={p.deviceId} policy={p} onSaved={(updated) =>
          setPolicies((prev) => prev.map((x) => x.deviceId === updated.deviceId ? updated : x))
        } />
      ))}
    </div>
  );
}

function PolicyCard({ policy, onSaved }: { policy: PolicyData; onSaved: (p: PolicyData) => void }) {
  const toLocalDatetime = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const [lockUntil, setLockUntil] = useState(toLocalDatetime(policy.lockUntil));
  const [offlineHours, setOfflineHours] = useState(String(policy.offlineOpenHours));
  const [hardCap, setHardCap] = useState(policy.hardCapHours != null ? String(policy.hardCapHours) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch(`/api/admin/devices/${policy.deviceId}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lockUntil: lockUntil ? new Date(lockUntil).toISOString() : null,
          offlineOpenHours: parseInt(offlineHours, 10),
          hardCapHours: hardCap ? parseInt(hardCap, 10) : null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const updated = await res.json();
      onSaved(updated);
      setSuccess(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearLock() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/devices/${policy.deviceId}/policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockUntil: null, offlineOpenHours: parseInt(offlineHours, 10), hardCapHours: hardCap ? parseInt(hardCap, 10) : null }),
      });
      if (!res.ok) throw new Error(await res.text());
      setLockUntil("");
      setSuccess(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="font-semibold mb-4">{policy.deviceName}</h2>
      <form onSubmit={handleSave} className="space-y-4">
        <Input
          id={`lockUntil-${policy.deviceId}`}
          label="Gesperrt bis (leer = kein Sperrziel)"
          type="datetime-local"
          value={lockUntil}
          onChange={(e) => setLockUntil(e.target.value)}
        />
        <Input
          id={`offline-${policy.deviceId}`}
          label="Offline-Failsafe (Stunden, 1–168)"
          type="number"
          min={1}
          max={168}
          required
          value={offlineHours}
          onChange={(e) => setOfflineHours(e.target.value)}
        />
        <Input
          id={`cap-${policy.deviceId}`}
          label="Hard-Cap (max. Stunden ab jetzt, leer = kein Cap)"
          type="number"
          min={1}
          max={720}
          value={hardCap}
          onChange={(e) => setHardCap(e.target.value)}
        />
        <FormError message={error} />
        {success && <p className="text-sm text-[var(--color-lock)]">Gespeichert.</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={saving}>Speichern</Button>
          {lockUntil && (
            <Button type="button" variant="secondary" onClick={handleClearLock} disabled={saving}>
              Sperre aufheben
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
