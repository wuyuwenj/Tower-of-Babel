# Tower of Babel — MVP Plan (rough)

**Pitch:** A survivors game with no level designer. Players climb a shared tower; the first to clear the top level forges the next one — the world model builds it, and a monument to them stands in it.

**Event:** Spatial Intelligence Hackathon, Sep 5 2026. Submissions 6 PM, 2-min demos 6–7 PM.
**Track:** Gaming & Interactive Worlds.

## Stack
- Vite + React + TypeScript (UI: HUD, cards, ladder, clear screen)
- Three.js + `@sparkjsdev/spark` 2.1 (Marble splat worlds) + `@dimforge/rapier3d-compat` (collider)
- Convex (levels ladder, runs, frontier mutation, actions calling Marble / Tripo / Claude)
- Deploy: Vercel (static) + Convex cloud

## Core loop (must ship)
1. WASD move, pulled-back chase camera, capsule player
2. Auto-attack nearest enemy in range (no aiming)
3. Enemies chase player; contact = damage; die → XP orb
4. Waves on a fixed timer; level = 3 waves; wave 3 ends with a boss → level clear
5. Level-up → pick 1 of 3 upgrade cards (stats from fixed tiers, names/colors themed)
6. Death → back to ladder screen

## Ladder (must ship)
- `levels` table: index, theme, prompt, splatUrl, colliderUrl, enemyUrl, monumentUrl, forgedBy, coForgers, status
- Ladder screen: list of levels, frontier highlighted, "forging…" state live via subscription
- `clearLevel` mutation: first commit creates level N+1 (status forging) + schedules forge action; losers land on plaque
- Checkpoints: player can start any level they've cleared (`progress.maxCleared`)

## Forge pipeline (must ship, pre-baked fallback)
- Action `forge.generate(levelId)`:
  1. Claude: theme → JSON {worldPrompt, enemyPrompt, monumentPrompt, waveComposition[], cardSkins[]} (enums + strings only, zod-validated)
  2. Marble API: `worlds:generate` → poll → spz (500k) + collider glb → store URLs
  3. Tripo API: enemy glb, monument glb
  4. `status = ready`
- On error → `status = failed`, next clear re-forges

## Balance (fixed, never generated)
- `budget(w) = 20 * 1.18^w`; archetype costs swarm 1 / fast 2 / tank 5 / boss 25
- Card tiers: damage / area / utility / defense × T1–T3
- Director: every 10s, ±20% spawn rate from dmg-taken & kills/sec, clamped
- Gameplay ring: fixed radius around spawn; rest of world is scenery

## Timeline (it's ~11:45)
| Time | Milestone |
|---|---|
| 12:30 | Vite project, Spark renders a provided world (haunted house / hobbiton), Rapier collider, capsule moves with WASD + chase cam |
| 1:30 | Enemies spawn on a ring, chase, auto-attack kills them, XP + HP bars |
| 2:30 | Waves, boss, level clear, upgrade cards (3 hand-tuned offers), death → restart |
| 3:15 | Convex: levels/runs/progress schema, ladder screen, clearLevel mutation with frontier race |
| 4:15 | Forge action (Claude → Marble → Tripo), live "forging" progress in UI; pre-forge levels 1–5 |
| 5:00 | Tripo enemy + monument loaded into level; plaque text |
| 5:30 | Deploy to Vercel, record fallback video, write submission |
| 6:00 | Submit. Demo: clear frontier on stage → forge banner → show pre-forged next level with monument |

## Cut list (do not build today)
- Real-time co-op, ghosts
- Rigged animations (enemies bob/hop)
- Photo → first level
- Roblox export
- Mobile controls
- Any in-game editor

## Pre-demo checklist
- 5 levels pre-forged with distinct themes, all cached and loading < 5s
- Level 6 pre-forged from the theme you'll pick on stage
- Fallback recording saved
- Reset button on ladder screen
