/** Zeitstempel für Server-Logs in lokaler Zeit (Europe/Zurich), Format "YYYY-MM-DD HH:MM:SS".
 *  Bewusst ohne weitere Imports gehalten → auch im Edge-Middleware-Runtime (proxy.ts) nutzbar.
 *  Die DB speichert weiterhin UTC (korrekt); dies betrifft nur die Log-Anzeige. */
export function logTs(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich" });
}
