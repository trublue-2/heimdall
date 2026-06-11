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
  const [link, setLink] = useState<string>("");
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (!ssid) return;
    setSaving(true);
    setError(null);
    try {
      // Token rotieren — Klartext ist nur in dieser Antwort verfügbar.
      const res = await fetch(`/api/admin/devices/${deviceId}/token`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { token } = await res.json();

      // Passwort Base64-kodieren (enc=b64) — nicht versehentlich als Klartext
      // im Link/Verlauf lesbar. UTF-8-sicher.
      const passB64 = btoa(unescape(encodeURIComponent(pass)));
      const url =
        `http://192.168.4.1/provision?ssid=${encodeURIComponent(ssid)}` +
        `&pass=${encodeURIComponent(passB64)}` +
        `&url=${encodeURIComponent(window.location.origin)}` +
        `&token=${encodeURIComponent(token)}&enc=b64`;

      setLink(url);
      setQr(await QRCode.toDataURL(url, { width: 320, margin: 1 }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Modal title={`Setup-QR — ${deviceName}`} onClose={onClose}>
      {!qr ? (
        <>
          <p className="text-xs text-[var(--foreground-muted)]">
            Heim-WLAN eingeben. Der QR enthält WLAN-Zugang + einen frischen Geräte-Token.
            Der alte Token bleibt <strong>1 Stunde gültig</strong> (Grace) — eine laufende Box
            synct weiter, bis sie mit diesem QR neu eingerichtet ist.
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
            <strong>Einfachster Weg:</strong> Link kopieren → mit WLAN{" "}
            <strong>Heimdall-Setup-…</strong> verbinden → auf der Setup-Seite der Box einfügen.
          </p>
          <Button onClick={copyLink} className="w-full">
            {copied ? "✓ Kopiert" : "Setup-Link kopieren"}
          </Button>

          <p className="text-xs text-[var(--foreground-muted)] pt-2">
            Oder QR scannen (am besten <em>vor</em> dem Verbinden mit dem Box-WLAN):
          </p>
          <div className="bg-white p-3 rounded-xl flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Setup-QR" width={240} height={240} />
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
