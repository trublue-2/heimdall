import { EventEmitter } from "events";

// Prozessweiter Event-Bus für Live-Updates (SSE).
// Single-Container-Setup → In-Memory-EventEmitter genügt.
// globalThis, damit Hot-Reload/Module-Reuse denselben Emitter teilt.
const g = globalThis as unknown as { __deviceBus?: EventEmitter };
export const deviceBus: EventEmitter = g.__deviceBus ?? (g.__deviceBus = new EventEmitter());
deviceBus.setMaxListeners(100);

/** Signalisiert allen offenen SSE-Clients, dass sich Gerätedaten geändert haben. */
export function notifyDeviceChange() {
  deviceBus.emit("change");
}
