import { NextResponse } from "next/server";
import { readParams, checkAcl } from "@/lib/mqttAuth";

// mosquitto-go-auth "aclcheck": Box nur auf ihr eigenes Topic-Subtree, Bridge auf alles.
export async function POST(req: Request) {
  const p = await readParams(req);
  return NextResponse.json({ Ok: checkAcl(p.username, p.topic) });
}
