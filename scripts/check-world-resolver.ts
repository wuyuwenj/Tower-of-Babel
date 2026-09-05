/**
 * The seed-world resolver decides whether a splat is cached locally or must
 * come from the CDN. Both the Vite dev server and the Vercel SPA rewrite
 * answer a missing /worlds/*.spz with 200 and the HTML app shell, so "the
 * request succeeded" is not the same question as "the file is there" — and
 * getting that wrong feeds HTML to a gzip decoder.
 *
 * Run: node scripts/check-world-resolver.ts
 */
const CDN = "https://storage.googleapis.com/forge-dev-public/hackathon-260227";
const WORLD = "/worlds/haunted-house.spz";

type Case = { name: string; reply: () => Response; want: string };

const cases: Case[] = [
  {
    name: "SPA rewrite answers a missing splat with the app shell",
    reply: () => new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    want: `${CDN}/haunted-house.spz`,
  },
  {
    // What Vite actually answers for a cached .spz: it has no mime mapping for
    // the extension, so the header is absent entirely. Verified against the
    // dev server. The check must be "not the app shell", never "is octet-stream".
    name: "the splat is cached and served with no content type",
    reply: () => new Response(null, { status: 200 }),
    want: WORLD,
  },
  {
    name: "the splat is cached and served as octet-stream",
    reply: () => new Response(null, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }),
    want: WORLD,
  },
  {
    name: "a 404 from a server with no rewrite",
    reply: () => new Response(null, { status: 404 }),
    want: `${CDN}/haunted-house.spz`,
  },
  {
    name: "the probe itself fails offline",
    reply: () => { throw new Error("network down"); },
    want: `${CDN}/haunted-house.spz`,
  },
];

let failed = 0;
for (const c of cases) {
  // Fresh module each case: the resolver memoizes by design.
  const { resolveWorldUrl } = await import(`../src/game/net.ts?case=${encodeURIComponent(c.name)}`);
  globalThis.fetch = (async () => c.reply()) as typeof fetch;

  const got = await resolveWorldUrl(WORLD);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) console.log(`      want ${c.want}\n      got  ${got}`);
}

console.log(failed ? `\n${failed} of ${cases.length} failing` : `\nall ${cases.length} passing`);
process.exit(failed ? 1 : 0);
