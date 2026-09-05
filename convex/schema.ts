import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const themeTag = v.union(
  v.literal("fire"),
  v.literal("ice"),
  v.literal("void"),
  v.literal("nature"),
  v.literal("tech"),
  v.literal("stone"),
);

export const archetype = v.union(
  v.literal("swarm"),
  v.literal("fast"),
  v.literal("tank"),
  v.literal("boss"),
);

export const cardSkin = v.object({
  slot: v.union(
    v.literal("damage"),
    v.literal("area"),
    v.literal("utility"),
    v.literal("defense"),
  ),
  name: v.string(),
  description: v.string(),
  tag: themeTag,
});

export const levelStatus = v.union(
  v.literal("forging:composing"),
  v.literal("forging:world"),
  v.literal("forging:creatures"),
  v.literal("sealed"),
  v.literal("ready"),
  v.literal("failed"),
);

export default defineSchema({
  levels: defineTable({
    index: v.number(),
    theme: v.string(),
    themeTag,
    status: levelStatus,

    // What the room voted for while this level's predecessor was the frontier.
    tally: v.record(v.string(), v.number()),

    // Prompts the composer produced (kept so a failed forge can be retried).
    worldPrompt: v.optional(v.string()),
    enemyPrompt: v.optional(v.string()),
    monumentPrompt: v.optional(v.string()),

    // Generated assets.
    splatUrl: v.optional(v.string()),
    colliderUrl: v.optional(v.string()),
    enemyUrl: v.optional(v.string()),
    monumentUrl: v.optional(v.string()),
    yOffset: v.optional(v.number()),
    scale: v.optional(v.number()),

    composition: v.optional(v.array(v.array(archetype))),
    cardSkins: v.optional(v.array(cardSkin)),

    // Authorship. forgedBy is the first player to CLEAR it, not who started it.
    forgedBy: v.union(v.string(), v.null()),
    coForgers: v.array(v.string()),

    forgeStartedAt: v.optional(v.number()),
    forgeEndedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    seed: v.optional(v.boolean()),
  }).index("by_index", ["index"]),

  runs: defineTable({
    user: v.string(),
    levelIndex: v.number(),
    score: v.number(),
    cleared: v.boolean(),
    timeSeconds: v.number(),
  })
    .index("by_level", ["levelIndex"])
    .index("by_user", ["user"]),

  progress: defineTable({
    user: v.string(),
    maxCleared: v.number(),
  }).index("by_user", ["user"]),
});
