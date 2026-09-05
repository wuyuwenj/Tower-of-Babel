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
      .then((res) => (isCached(res) ? url : remote))
      .catch(() => remote);
    checked.set(url, hit);
  }
  return hit;
}

/**
 * A 200 is not proof the splat is there. The Vite dev server and the Vercel
 * SPA rewrite both answer a missing /worlds/*.spz with the HTML app shell and
 * a 200, so status alone sends the loader off to gunzip `<!doctype html>` and
 * fail with "Invalid gzip header" — with the CDN fallback never consulted.
 * The content type is what actually distinguishes the file from the shell.
 */
function isCached(res: Response): boolean {
  if (!res.ok) return false;
  return !(res.headers.get("content-type") ?? "").includes("text/html");
}
