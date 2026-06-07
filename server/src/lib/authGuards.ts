import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function requireSessionApi() {
  const session = await auth();
  if (!session?.user?.id) {
    return { session: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { session, response: null };
}

export async function requireAdminApi() {
  const { session, response } = await requireSessionApi();
  if (response) return { session: null, response };
  const role = (session!.user as { role?: string }).role;
  if (role !== "admin") {
    return { session: null, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, response: null };
}
