/** These policies are deliberately narrower than URL's permissive host normalisation. */
export function allowedDashboardURL(value: string): boolean {
  if (
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(
      value,
    )
  )
    return false;
  try {
    const u = new URL(value);
    return Number(u.port) > 0 && Number(u.port) <= 65535;
  } catch {
    return false;
  }
}
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
