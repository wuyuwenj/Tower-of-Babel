# Reliable world generation

How to make every rung — seeds and forged alike — come out with an empty
arena in the middle, the spawn inside it, real collision, and known scale.
Written 2026-09-05 after measuring what the pipeline actually produces.

## What went wrong, with numbers

Every world so far has been generated from **text**. A text prompt lets the
model choose the camera, and in Marble and Mint the camera *is* the world
origin — where the player spawns. Four Mint regenerations with an explicit
"wide, completely empty circular clearing at the exact centre" clause came back
as 2.5–5 m rooms with the origin in a corridor or against a wall:

| world | clear radius at spawn | best clearing anywhere |
|---|---|---|
| haunted house | 1.75 m | 3.25 m, 5.9 m away |
| cozy ship | 1.75 m | 2.5 m |
| cozy cottage | 2.0 m | 5.0 m |
| derelict spaceship | 0 (in a wall) | 3.5 m, under a 4 m ceiling |

The game is built for a 30 m arena. No prompt wording closes that gap, because
"thirty metres" is not a knob the model has — Mint's own runtime guidance
calibrates worlds with a fixed 2.5× display scale.

Two other things were being estimated that the provider actually reports:
floor height (we took the 12th percentile of a point cloud) and scale (we
guessed per level). Both were wrong often enough to matter.

## What Marble exposes that the forge was not using

`POST https://api.worldlabs.ai/marble/v1/worlds:generate`, header `WLT-Api-Key`.

| field | effect | forge today |
|---|---|---|
| `world_prompt.type: "image"` + `is_pano: "true"` | generate from an equirectangular panorama — "maximum control over the world" | text only |
| `type: "multi-image"` with `azimuth` per image | 4–8 views around one point, placed by compass angle | — |
| `disable_recaption: true` | use the prompt verbatim; **Marble rewrites prompts by default** (as `enrich()` already does — the arena clause was being rewritten twice) | recaption on |
| `seed` (0–2³²) | reproducible; a re-roll is a new seed | — |
| `model: "marble-1.1-plus"` | "dynamic world sizing" for outdoor / spacious indoor | `marble-1.1` |
| `assets.splats.semantics_metadata.metric_scale_factor` | multiply raw XYZ by this to get metres (1.0 = could not infer) | discarded |
| `assets.splats.semantics_metadata.ground_plane_offset` | subtract from metric Y to put the ground at y = 0 | discarded |
| `assets.mesh.collider_mesh_url` | collider GLB (plain trimesh, no Draco) | used, via URL regex |
| `POST /marble/v1/pano:depth_to_rgb` | **depth panorama + text → photoreal RGB panorama** on that exact geometry | — |

`levels` already has `yOffset` and `scale` columns. Nothing writes them.

## The pipeline

1. **Author the layout as depth.** `scripts/arena-pano.mjs` ray-traces an
   equirectangular panorama with the camera at eye height in the exact centre
   of an empty floor and every wall, tree and building on a ring at `--arena`
   metres. It writes a 16-bit depth pano (`--depth`) alongside the RGB one.
   Deterministic, 1 s, no GPU, no credits.
2. **Let Marble paint it.** `pano:depth_to_rgb` with the theme text turns that
   depth into a photoreal panorama of the *same geometry*. Inspect it; it costs
   ~80 credits, so iterating here is cheap. (Fallback: skip this step and send
   the ray-traced RGB pano directly — the pano guide accepts renders.)
3. **Generate the world from the panorama.** `scripts/forge-pano.ts`:
   `type: "image"`, `is_pano: "true"`, `disable_recaption: true`, a fixed
   `seed`. The panorama is by construction the full view from one point, so the
   world is built with that point standing in the clearing we drew.
4. **Read the metadata.** `metric_scale_factor` → `scale`,
   `ground_plane_offset` → `yOffset`, `collider_mesh_url` → `colliderUrl`.
   Stop estimating any of them.
5. **Gate before shipping.** The pre-flight (decode SPZ, parse the collider,
   apply the game's transform, run `colliderAgreesWithSplat` and the ray-fit)
   must report a clear disc at the origin ≥ target and an accepted collider.
   On failure, re-roll with the next seed. Rate limit is ~3 starts/min, 60/hour.
6. **Runtime fit stays on** as the safety net (`World.fitArenaToCollider`,
   the ring wall, ceiling-proof `groundHeight`).

## Cost

| | credits |
|---|---|
| `marble-1.0-draft`, pano input | 150 |
| `marble-1.1`, pano input | 1,500 |
| `marble-1.1-plus`, pano input | 1,500–3,000 |
| text → pano | 80 |
| HQ mesh export | 3,500 (not needed; the collider is free) |

Balance at time of writing: 7,000. Plan for today: one draft to prove the
pipeline end to end (150), then level 1 at `marble-1.1` (1,500). Seeds 2–4 keep
their samples; forged rungs keep Mint until the forge is switched over.

## Rollout

- [ ] Prove: draft world from the arena depth pano → pre-flight → look at it.
- [ ] Level 1 at `marble-1.1` from the same pano and seed; swap it into
      `SEED_LEVELS` with the reported scale, ground offset and collider.
- [ ] Forge: add `disable_recaption`, `seed`, `semantics_metadata` and the gate
      to `convex/forge.ts`'s Marble path; prefer Marble over Mint when a
      `WORLDLABS_API_KEY` is present, since Mint exposes none of the above.
- [ ] Forge: generate each rung's pano from the theme's depth layout instead of
      free text, so rungs 5+ get the same guarantee as level 1.

## Open questions (settle on the draft run)

- The docs do not state outright that the pano camera becomes the world
  origin; it follows from what a panorama is, but the draft run is the proof.
- `pano:depth_to_rgb` PNG depth conventions: `z_min`/`z_max` in metres, linear
  16-bit assumed. Verify against the returned pano before relying on it.
- `data_base64` payload limits are undocumented. A 2048×1024 JPEG (~110 KB)
  is the working assumption; fall back to `media-assets:prepare_upload`.

## What exists on this branch

- `scripts/arena-pano.mjs` — the layout renderer (RGB + depth). Exercised.
- `scripts/forge-pano.ts` — Marble generate / poll / download, resumable.
  Parses and runs to its argument guard; **not yet run against the API**.
- `scripts/forge-seeds.ts` + `scripts/seed-worlds.json` — the four Mint
  regenerations, kept as evidence and as alternates.
- Runtime: ring wall, collider-fitted radius, ceiling-proof ground rays,
  corrected splat sampler, per-seed remotes for the cache.
