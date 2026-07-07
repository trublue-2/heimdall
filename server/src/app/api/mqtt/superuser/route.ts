import { NextResponse } from "next/server";
import { readParams, checkSuperuser } from "@/lib/mqttAuth";

// mosquitto-go-auth "superuser": nur das Bridge-Konto. Antwort: {"Ok": bool}.
export async function POST(req: Request) {
  const p = await readParams(req);
  return NextResponse.json({ Ok: checkSuperuser(p.username, p.password) });
}
