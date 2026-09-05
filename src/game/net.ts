/**
 * Seed worlds are served locally when cached and fall back to the CDN when not.
 * A HEAD probe keeps the fallback silent instead of failing a level load.
 */
const REMOTE_BASE = "https://storage.googleapis.com/forge-dev-public/hackathon-260227";
const checked = new Map<string, Promise<string>>();

export function resolveWorldUrl(url: string): Promise<string> {
  if (!url.startsWith("/worlds/")) return Promise.resolve(url);

  let hit = checked.get(url);
  if (!hit) {
    const remote = `${REMOTE_BASE}/${url.slice("/worlds/".length)}`;
    hit = fetch(url, { method: "HEAD" })
      .then((res) => (res.ok ? url : remote))
      .catch(() => remote);
    checked.set(url, hit);
  }
  return hit;
}
