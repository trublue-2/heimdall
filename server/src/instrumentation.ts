// Läuft einmal beim Server-Start (Next.js instrumentation hook).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // MQTT-Bridge EAGER verbinden: die Präsenz-Liste (retained status-Topics) muss warm sein,
    // BEVOR der erste tracker/notify deviceOnline() fragt — lazy verband die Bridge erst in
    // genau diesem Moment, und der erste Instant-Push nach einem Neustart ging verloren.
    const { initBridge } = await import("@/lib/mqttBridge");
    initBridge();
  }
}
