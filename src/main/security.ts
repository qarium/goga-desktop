export { allowedDashboardURL } from "../shared/dashboard-connection";
export function sameDashboardOrigin(
  origin: string,
  target: string,
  sockets = false,
): boolean {
  try {
    const a = new URL(origin),
      b = new URL(target);
    if (b.username || b.password) return false;
    return (
      b.host === a.host &&
      (b.protocol === a.protocol ||
        (sockets && a.protocol === "http:" && b.protocol === "ws:"))
    );
  } catch {
    return false;
  }
}
export function validShellSender(
  sender: number,
  shell: number,
  url: string,
  expected: string,
  mainFrame: boolean,
): boolean {
  return sender === shell && mainFrame && url === expected;
}
/** Kept in sync with fixed shell header/tabs/context heights in style.css. */
export function viewBounds(width: number, height: number) {
  return {
    x: 236,
    y: 212,
    width: Math.max(0, width - 236),
    height: Math.max(0, height - 212),
  };
}
