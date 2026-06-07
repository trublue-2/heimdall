export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p className="text-sm text-[var(--color-warn)] bg-[var(--color-warn-bg)] border border-[var(--color-warn-border)] rounded-xl px-4 py-3">
      {message}
    </p>
  );
}
