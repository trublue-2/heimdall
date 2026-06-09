"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card } from "./Card";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";
import { DeviceActions } from "./DeviceActions";
import { TokenDisplayModal } from "./TokenDisplayModal";

interface U { id: string; username: string; }
interface D { id: string; name: string; assignedUserIds: string[]; }

export function DeviceManager({ devices, users }: { devices: D[]; users: U[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setToken(data.token);
      setName("");
      router.refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {devices.map((d) => (
        <DeviceRow key={d.id} device={d} users={users} />
      ))}

      <Card>
        <form onSubmit={create} className="space-y-3">
          <p className="text-sm font-medium">Neues Gerät</p>
          <Input id="new-device" label="Gerätename" required value={name} onChange={(e) => setName(e.target.value)} />
          <FormError message={error} />
          <Button type="submit" loading={saving}>Gerät anlegen</Button>
        </form>
      </Card>

      {token && <TokenDisplayModal token={token} onClose={() => setToken(null)} />}
    </div>
  );
}

function DeviceRow({ device, users }: { device: D; users: U[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(device.assignedUserIds);
  const [saving, setSaving] = useState(false);
  const dirty = selected.slice().sort().join() !== device.assignedUserIds.slice().sort().join();

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function saveAssign() {
    setSaving(true);
    await fetch(`/api/admin/devices/${device.id}/assignments`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: selected }),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/dashboard/devices/${device.id}`} className="font-medium text-sm hover:underline">
          {device.name}
        </Link>
        <div className="flex items-center gap-2">
          <DeviceActions deviceId={device.id} deviceName={device.name} />
        </div>
      </div>

      <div>
        <p className="text-xs text-[var(--foreground-faint)] mb-1.5">Zugewiesene Konten</p>
        {users.length === 0 ? (
          <p className="text-xs text-[var(--foreground-muted)]">Keine Konten vorhanden.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {users.map((u) => (
              <label key={u.id} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
                {u.username}
              </label>
            ))}
          </div>
        )}
      </div>

      {dirty && (
        <Button onClick={saveAssign} loading={saving} className="text-xs px-3 py-1.5">
          Zuweisung speichern
        </Button>
      )}
    </Card>
  );
}

