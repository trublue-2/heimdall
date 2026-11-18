import type { NextRequest } from "next/server";
import type { TrackerInstance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { extractBearerToken } from "@/lib/device-auth";

/**
 * Welche Tracker-Instanz ruft hier an? Auth = `TrackerInstance.apiKey` als Bearer — derselbe
 * Shared-Secret-Kanal wie outbound (`trackerClient.ts`), nur rückwärts. `null` = nicht berechtigt.
 */
export async function authenticateTrackerInstance(req: NextRequest): Promise<TrackerInstance | null> {
  const token = extractBearerToken(req.headers.get("authorization"));
  if (!token) return null;
  return prisma.trackerInstance.findUnique({ where: { apiKey: token } });
}
