"use client";
import { useState } from "react";
import { Card } from "@/app/components/Card";
import { Button } from "@/app/components/Button";
import { Input } from "@/app/components/Input";
import { FormError } from "@/app/components/FormError";
import { Copy, Check } from "lucide-react";

export default function NewDevicePage() {
  const [name, setName] = useState("Heimdall");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
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
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (token) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Gerät angelegt</h1>
        <Card className="space-y-4">
          <p className="text-sm font-medium text-[var(--color-warn)]">
            Dieser Token wird nur einmal angezeigt. Jetzt kopieren!
          </p>
          <div className="bg-[var(--background-subtle)] rounded-xl p-4 font-mono text-lg tracking-widest text-center select-all">
            {token}
          </div>
          <p className="text-xs text-[var(--foreground-muted)]">
            Trage diesen Token beim Provisioning ins Captive Portal der Box ein (WLAN-Verbindung zur Box nötig).
          </p>
          <Button onClick={copyToken} variant="secondary" className="w-full">
            {copied ? <><Check className="h-4 w-4" /> Kopiert!</> : <><Copy className="h-4 w-4" /> Token kopieren</>}
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Neues Gerät anlegen</h1>
      <Card>
        <form onSubmit={handleCreate} className="space-y-4">
          <Input
            id="device-name"
            label="Gerätename"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormError message={error} />
          <Button type="submit" loading={saving}>Gerät anlegen & Token generieren</Button>
        </form>
      </Card>
    </div>
  );
}
