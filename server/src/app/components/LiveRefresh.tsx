"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Ruft router.refresh() periodisch auf — hält Server-Component-Daten aktuell. */
export function LiveRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
