"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Hält Server-Component-Daten live:
 * - SSE-Push (/api/events/stream) → sofortiges router.refresh() bei Änderung
 * - Fallback-Poll als Sicherheitsnetz, falls SSE blockiert ist (Proxy o.ä.)
 */
export function LiveRefresh({ fallbackMs = 30_000 }: { fallbackMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const es = new EventSource("/api/events/stream");
    es.onmessage = () => router.refresh();
    // onerror → EventSource reconnectet automatisch; kein Handling nötig

    const poll = setInterval(() => router.refresh(), fallbackMs);

    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [router, fallbackMs]);

  return null;
}
