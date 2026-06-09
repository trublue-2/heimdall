"use client";

import { Modal } from "./Modal";
import { Button } from "./Button";

/** Zeigt einen frisch generierten Provisioning-Token einmalig an. */
export function TokenDisplayModal({
  token,
  deviceName,
  onClose,
}: {
  token: string;
  deviceName?: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Provisioning-Token" onClose={onClose}>
      <p className="text-sm text-[var(--foreground-muted)]">
        Dieser Token wird <strong>nur einmal</strong> angezeigt. Jetzt ins Captive Portal der Box eintragen.
      </p>
      <div className="bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl px-4 py-3 text-center">
        <code className="text-lg font-mono font-bold tracking-widest text-[var(--color-lock)]">{token}</code>
      </div>
      {deviceName && (
        <p className="text-xs text-[var(--foreground-muted)] text-center">
          Gerät: <strong>{deviceName}</strong>
        </p>
      )}
      <Button onClick={onClose} variant="secondary" className="w-full">Verstanden, Token notiert</Button>
    </Modal>
  );
}
