import { requireSessionApi } from "@/lib/authGuards";
import { deviceBus } from "@/lib/events";

export const dynamic = "force-dynamic";

// SSE-Stream: schickt "change", sobald sich Gerätedaten ändern.
// Client (LiveRefresh) ruft daraufhin router.refresh() auf.
export async function GET(req: Request) {
  const { response } = await requireSessionApi();
  if (response) return response;

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (msg: string) => controller.enqueue(enc.encode(msg));
      send(": connected\n\n");

      const onChange = () => send("data: change\n\n");
      deviceBus.on("change", onChange);

      // Keepalive gegen Proxy-Timeouts
      const keepAlive = setInterval(() => send(": ka\n\n"), 25_000);

      const close = () => {
        clearInterval(keepAlive);
        deviceBus.off("change", onChange);
        try { controller.close(); } catch { /* bereits geschlossen */ }
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Proxy-Buffering deaktivieren (Traefik/nginx)
    },
  });
}
