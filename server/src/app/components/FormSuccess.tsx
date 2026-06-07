import { CheckCircle } from "lucide-react";

export function FormSuccess({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-unlock)] bg-[var(--color-unlock-bg)] border border-[var(--color-unlock-border)] rounded-xl px-3 py-2">
      <CheckCircle className="h-4 w-4 shrink-0" />
      {message}
    </div>
  );
}
