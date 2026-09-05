# Tower of Babel

**A survivors game with no level designer.** Players climb a shared tower. Every
upgrade card you pick is a vote on what the next level becomes. When the first
player reaches the frontier's boss, the tower forges the next rung — a whole 3D
world, its creatures, and its upgrade cards — and whoever clears it first gets a
monument standing inside it.

Built at the Spatial Intelligence Hackathon, Founders Inc, September 5 2026.
Track: **Gaming & Interactive Worlds**.

---

## The interaction loop

```
move (WASD) ─► auto-attack ─► collect XP ─► pick 1 of 3 cards ─┐
      ▲                                                         │
      └──────────── survive 3 waves, kill the boss ◄────────────┘
                              │
                    first to reach the boss
                              │
                              ▼
              theme tally ─► world + creatures + cards
                              │
                              ▼
                    a new rung on the tower
                    (monument: first to clear it)
```

The level designer is the room.

## What each technology does

| Tech | Role |
|---|---|
| **Mint** | The forge. `worlds:generate` returns the SPZ splat + collider mesh; `models:generate` returns the creature and monument GLBs. One key, whole pipeline. |
| **Spark** (World Labs) | Renders the Gaussian splat worlds in the browser, fused with the Three.js scene. |
| **Rapier** | Collides the player against the generated collider mesh; ray-samples ground height for 300 enemies. |
| **Convex** | The shared tower: the ladder, the live theme tally, the forge race, leaderboards, and the action that drives the generation. |
| **OpenAI** | Optional. Rewords flavor only — never numbers. |

World Labs Marble and Tripo are wired as alternate providers; set their keys and
they take over from Mint.

## Freedom vs. quality

Generated content decides **what things are**. It never decides **how strong they are**.

- **Fixed** (`src/game/balance.ts`): difficulty curve, wave point budget
  `20 × 1.18^wave`, archetype costs, card stat tiers, player base stats.
- **Templated**: the composer picks enemy archetypes per wave and card slots
  from enums, then spends the wave's point budget on them.
- **Free**: the world, the creature, the theme name, the card names and colors.

`convex/composer.ts` is a deterministic hand-authored table, so a level composes
instantly, for free, and cannot fail. The OpenAI pass only rewrites wording, and
falls back silently on any error. A `Director` (`src/game/director.ts`) nudges
spawn rate ±20% within a hard clamp to absorb variance from generated geometry —
it can never change the authored curve.

## Concurrency: who forges, who is remembered

Two players can hit the frontier boss in the same instant. Convex mutations are
serializable transactions, so the race resolves itself:

- `reachedBoss` reads level `N+1` and inserts it **in the same transaction**.
  The loser re-runs against committed state, sees the row, and no-ops.
- `clearLevel` sets `forgedBy` only if it is still null; everyone else who
  clears while the forge runs is appended to `coForgers` and named on the plaque.
- A forged-but-uncleared level sits `sealed`: visible on the ladder, not
  enterable. "Level 7 is forged. Clear 6 to open it."
- A forge that dies mid-flight goes stale after 20 minutes and becomes retryable,
  so one bad run cannot wedge the tower.

## Running it

```bash
npm install
npx convex dev          # backend + codegen (npx convex login first, to share the tower)
npm run dev             # http://localhost:5173
```

Keys go in the Convex environment, never in a `VITE_` var:

```bash
npx convex env set MINT_API_KEY   ...   # worlds + creatures
npx convex env set OPENAI_API_KEY ...   # optional flavor pass
```

Every key is optional. Without `MINT_API_KEY` a forged rung reuses a seed world;
without any Convex deployment the tower runs single-player over the seed levels.
The game is always playable.

## Layout

```
src/game/     balance · waves · director · enemies · combat · player · world · monument
src/ui/       Hud · Cards · Ladder · ClearScreen
convex/       schema · levels (the three mutations) · forge · composer · mint · enrich
```

## Controls

`WASD` move · `Q`/`E` rotate camera · attacks fire themselves
