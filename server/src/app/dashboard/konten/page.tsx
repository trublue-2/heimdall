import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AccountManager } from "@/app/components/AccountManager";

export const dynamic = "force-dynamic";

export default async function KontenPage() {
  const session = await auth();
  if ((session!.user as { role?: string }).role !== "admin") redirect("/dashboard");

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, role: true },
  });

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold">Konten</h1>
      <AccountManager users={users} />
    </div>
  );
}
