"use client";

import { useState } from "react";
import QRCode from "qrcode";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { FormError } from "./FormError";

/**
 * Setup-QR: erzeugt einen QR-Code mit Provisioning-Link für den Box-Hotspot.
 * Der Link (http://192.168.4.1/provision?…) bündelt Heim-WLAN, Server-URL und
 * einen frisch rotierten Geräte-Token. Token-Klartext bleibt nur im Browser.
 */
export function SetupQrModal({
  deviceId,
  deviceName,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
}) {
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  async function generate() {
    if (!ssid) return;
    setSaving(true);
    setError(null);
    try {
      // Token rotieren — Klartext ist nur in dieser Antwort verfügbar.
      const res = await fetch(`/api/admin/devices/${deviceId}/token`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { token } = await res.json();

      const url =
        `http://192.168.4.1/provision?ssid=${encodeURIComponent(ssid)}` +
        `&pass=${encodeURIComponent(pass)}` +
        `&url=${encodeURIComponent(window.location.origin)}` +
        `&token=${encodeURIComponent(token)}`;

      setQr(await QRCode.toDataURL(url, { width: 320, margin: 1 }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Setup-QR — ${deviceName}`} onClose={onClose}>
      {!qr ? (
        <>
          <p className="text-xs text-[var(--foreground-muted)]">
            Heim-WLAN eingeben. Der QR enthält WLAN-Zugang + einen frischen Geräte-Token.
            Beim Erzeugen wird der <strong>alte Token ungültig</strong> — die Box synct erst
            wieder, nachdem sie mit diesem QR eingerichtet wurde.
          </p>
          <Input id={`qr-ssid-${deviceId}`} label="WLAN-Name (SSID)" value={ssid} onChange={(e) => setSsid(e.target.value)} />
          <Input id={`qr-pass-${deviceId}`} label="WLAN-Passwort" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          <FormError message={error} />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Abbrechen</Button>
            <Button onClick={generate} loading={saving} disabled={!ssid}>QR erzeugen</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-[var(--foreground-muted)]">
            1. Mit dem WLAN <strong>Heimdall-Setup-…</strong> der Box verbinden.<br />
            2. Diesen QR scannen → die Box speichert und verbindet sich neu.
          </p>
          <div className="bg-white p-3 rounded-xl flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Setup-QR" width={280} height={280} />
          </div>
          <p className="text-[11px] text-center text-[var(--color-warn)]">
            ⚠️ Enthält WLAN-Passwort + Token — nicht weitergeben.
          </p>
          <Button variant="secondary" className="w-full" onClick={onClose}>Fertig</Button>
        </>
      )}
    </Modal>
  );
}
