import { NextResponse } from "next/server";
import { readParams, checkUser } from "@/lib/mqttAuth";

// mosquitto-go-auth "getuser". Öffentlich (eigene Credential-Prüfung), aber rate-limitiert
// im Proxy (bcrypt-DoS-Schutz). Antwort im json-Response-Mode: {"Ok": bool}.
export async function POST(req: Request) {
  const p = await readParams(req);
  const ok = await checkUser(p.username, p.password);
  return NextResponse.json({ Ok: ok });
}
