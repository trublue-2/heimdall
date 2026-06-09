"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { User, KeyRound, LogOut } from "lucide-react";
import { handleSignOut } from "@/lib/actions";

export function AvatarMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const initial = username.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center h-8 w-8 rounded-full bg-[var(--color-lock)] text-white text-sm font-semibold"
        title={username}
      >
        {initial || <User className="h-4 w-4" />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl py-1 z-50">
          <div className="px-3 py-2 text-xs text-[var(--foreground-muted)] border-b border-[var(--border-subtle)]">
            Angemeldet als <span className="font-medium text-[var(--foreground)]">{username}</span>
          </div>
          <Link
            href="/dashboard/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--surface-raised)]"
          >
            <KeyRound className="h-4 w-4" /> Passwort ändern
          </Link>
          <form action={handleSignOut}>
            <button
              type="submit"
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--surface-raised)] text-[var(--color-warn)]"
            >
              <LogOut className="h-4 w-4" /> Abmelden
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
