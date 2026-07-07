"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Toggle } from "./Toggle";
import { FormError } from "./FormError";

/** Einheitlicher Geräte-Schalter: wendet SOFORT an (optimistisch, PATCH on-change) mit
 *  Inline-Feedback. Ein Muster für ALLE booleschen Box-Einstellungen (OTA, Debug, MQTT,
 *  Server-Log) statt gemischt „on change" vs. „Speichern-Button". */
export function SettingToggle({
  deviceId,
  field,
  checked,
  title,
  desc,
}: {
  deviceId: string;
  field: string;
  checked: boolean;
  title: string;
  desc: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(checked);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setOn(next); // optimistisch
    setError(null);
    setSaved(false);
    try {
      const r = await fetch(`/api/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      router.refresh(); // server-gerenderte Status-Anzeigen konsistent halten
    } catch (e) {
      setOn(!next); // zurückrollen
      setError(String(e));
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <Toggle checked={on} onChange={change} title={title} desc={desc} />
        {saved && <span className="shrink-0 text-xs text-[var(--color-lock)] mt-0.5">✓ gespeichert</span>}
      </div>
      <FormError message={error} />
    </div>
  );
}
