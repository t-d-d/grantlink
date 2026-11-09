import { isIP } from "node:net";

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1" || bare.startsWith("::ffff:127.");
  return false;
}
