/**
 * Turns a level's theme tally into everything the forge needs.
 *
 * Deliberately NOT an LLM call: it is instant, free, deterministic, and can
 * never fail mid-demo. It only ever produces flavor (prompts, names, colors)
 * and enum choices — every gameplay number still comes from balance.ts.
 */

export type ThemeTag = "fire" | "ice" | "void" | "nature" | "tech" | "stone";
export type Archetype = "swarm" | "fast" | "tank" | "boss";
export type CardSlot = "damage" | "area" | "utility" | "defense";

export interface CardSkin {
  slot: CardSlot;
  name: string;
  description: string;
  tag: ThemeTag;
}

export interface Composition {
  theme: string;
  themeTag: ThemeTag;
  worldPrompt: string;
  enemyPrompt: string;
  monumentPrompt: string;
  composition: Archetype[][];
  cardSkins: CardSkin[];
}

interface ThemeEntry {
  name: string;
  world: string;
  enemy: string;
  monument: string;
  waves: Archetype[][];
  cards: Array<[CardSlot, string, string]>;
}

const THEMES: Record<ThemeTag, ThemeEntry> = {
  fire: {
    name: "ember wastes",
    world:
      "a scorched volcanic basin at dusk, cracked obsidian ground, lava vents glowing orange, ash drifting through the air, ruined stone arches, wide open floor",
    enemy: "a small hunched magma creature made of cracked black rock with glowing orange seams",
    monument: "a tall obsidian statue of a lone warrior holding a burning blade aloft",
    waves: [["swarm"], ["swarm", "fast"], ["boss", "fast", "swarm"]],
    cards: [
      ["damage", "Cinder Fang", "+damage, faster attacks"],
      ["area", "Ember Ring", "Attacks burst outward in flame"],
      ["utility", "Ashstep", "+speed, wider pickup"],
      ["defense", "Slag Plating", "+max HP and regen"],
    ],
  },
  ice: {
    name: "frozen reach",
    world:
      "a windswept glacier field under pale blue light, fractured ice shelves, frozen pillars, drifting snow, a wide flat basin surrounded by ice walls",
    enemy: "a jagged crystalline creature of pale blue ice with sharp angular limbs",
    monument: "a statue carved from clear blue ice of a figure raising a frozen spear",
    waves: [["swarm"], ["swarm", "tank"], ["boss", "tank", "swarm"]],
    cards: [
      ["area", "Frost Nova", "Attacks shatter outward in ice"],
      ["damage", "Rimeblade", "+damage, faster attacks"],
      ["defense", "Glacial Hide", "+max HP and regen"],
      ["utility", "Sleet Skate", "+speed, wider pickup"],
    ],
  },
  void: {
    name: "hollow dark",
    world:
      "a derelict haunted manor interior at night, warped wooden floors, broken furniture, dust in shafts of moonlight, long shadowed hallways opening into a wide hall",
    enemy: "a tattered shadow wraith with hollow glowing eyes and trailing dark cloth",
    monument: "a dark stone statue of a hooded figure holding a lantern of pale light",
    waves: [["swarm"], ["fast", "swarm"], ["boss", "fast"]],
    cards: [
      ["damage", "Killing Intent", "+damage, faster attacks"],
      ["utility", "Umbral Step", "+speed, wider pickup"],
      ["area", "Null Pulse", "Attacks collapse space around them"],
      ["defense", "Grave Shroud", "+max HP and regen"],
    ],
  },
  nature: {
    name: "overgrown hollow",
    world:
      "a sunlit forest clearing deep in an overgrown valley, mossy stone ruins, thick tree trunks, hanging vines, a wide grassy floor with scattered boulders",
    enemy: "a small gnarled creature of bark, moss and twisted roots with glowing green eyes",
    monument: "a moss-covered stone statue of a figure holding a blooming branch",
    waves: [["swarm"], ["swarm", "tank"], ["boss", "swarm", "tank"]],
    cards: [
      ["defense", "Second Wind", "+max HP and regen"],
      ["utility", "Thornstride", "+speed, wider pickup"],
      ["damage", "Bramble Edge", "+damage, faster attacks"],
      ["area", "Root Burst", "Attacks erupt through the ground"],
    ],
  },
  tech: {
    name: "derelict works",
    world:
      "the interior of an abandoned spacecraft hangar, scuffed metal decking, exposed cabling, flickering panel lights, a wide open bay surrounded by bulkheads",
    enemy: "a battered quadruped maintenance drone with exposed wiring and a single glowing sensor",
    monument: "a polished chrome statue of a figure holding a fractured circuit core",
    waves: [["swarm"], ["fast", "swarm"], ["boss", "fast", "tank"]],
    cards: [
      ["area", "Shockwave", "Attacks discharge in an arc"],
      ["utility", "Servo Boost", "+speed, wider pickup"],
      ["damage", "Railspike", "+damage, faster attacks"],
      ["defense", "Ablative Plate", "+max HP and regen"],
    ],
  },
  stone: {
    name: "sunken hall",
    world:
      "a vast ruined stone hall half sunk in shallow water, toppled columns, carved masonry, shafts of light from a broken ceiling, a wide flat flooded floor",
    enemy: "a squat animated statue of cracked grey stone with moss in its seams",
    monument: "a weathered granite statue of a figure resting both hands on a great shield",
    waves: [["swarm"], ["tank", "swarm"], ["boss", "tank"]],
    cards: [
      ["defense", "Bulwark", "+max HP and regen"],
      ["damage", "Sharpened Edge", "+damage, faster attacks"],
      ["area", "Rockslide", "Attacks crash outward in stone"],
      ["utility", "Sure Footing", "+speed, wider pickup"],
    ],
  },
};

const MASHUP_NAMES: Record<string, string> = {
  "fire|ice": "riven glacier",
  "fire|nature": "burning grove",
  "fire|stone": "molten hall",
  "fire|tech": "reactor ruin",
  "fire|void": "ashen dark",
  "ice|nature": "frostbound grove",
  "ice|stone": "frozen hall",
  "ice|tech": "cryo works",
  "ice|void": "pale hollow",
  "nature|stone": "overgrown ruin",
  "nature|tech": "reclaimed works",
  "nature|void": "rotted hollow",
  "stone|tech": "buried works",
  "stone|void": "sunken crypt",
  "tech|void": "dead signal",
};

/**
 * Appended to every world prompt.
 *
 * The game pens the player into a circular arena (see World.buildArenaWall).
 * That wall is invisible, so a world whose middle is cluttered reads as the
 * player being stopped by nothing. Asking for a clear centre makes the
 * generated geometry agree with the collision it is going to get.
 */
export const ARENA_CLAUSE =
  "at the exact centre of the scene is a wide, completely empty circular clearing, flat and " +
  "unobstructed, at least thirty metres across, with nothing at all standing inside it; every " +
  "wall, building, structure, prop and obstacle stands in a ring around the edge of that " +
  "clearing, facing inward";

export function withArena(prompt: string): string {
  return prompt.includes(ARENA_CLAUSE) ? prompt : `${prompt}, ${ARENA_CLAUSE}`;
}

export const THEME_TAGS: ThemeTag[] = ["fire", "ice", "void", "nature", "tech", "stone"];

/**
 * Appended to every creature prompt at generation time — after enrich(), which
 * is free to reword the flavor and would otherwise drop these constraints.
 * A forged enemy is instanced a few hundred times and normalized to 1 unit
 * tall, so it has to be one clean full-body figure with no plinth: the same
 * wording the baked creatures in public/creatures were made with.
 */
export const CREATURE_SUFFIX =
  ", single creature, full body, standing on the ground, facing forward, game asset, clean silhouette, no base, no background";

function topTags(tally: Record<string, number>): ThemeTag[] {
  const entries = THEME_TAGS.map((t) => [t, tally[t] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ["stone"];

  const [, top] = entries[0];
  // A second tag only counts as a mash-up if the room was genuinely split.
  const close = entries.filter(([, n]) => n >= top * 0.6).map(([t]) => t);
  return close.slice(0, 2);
}

export function compose(tally: Record<string, number>): Composition {
  const tags = topTags(tally);
  const primary = THEMES[tags[0]];

  if (tags.length < 2) {
    return {
      theme: primary.name,
      themeTag: tags[0],
      worldPrompt: primary.world,
      enemyPrompt: primary.enemy,
      monumentPrompt: primary.monument,
      composition: primary.waves,
      cardSkins: primary.cards.map(([slot, name, description]) => ({
        slot,
        name,
        description,
        tag: tags[0],
      })),
    };
  }

  const secondary = THEMES[tags[1]];
  const key = [tags[0], tags[1]].sort().join("|");
  const name = MASHUP_NAMES[key] ?? `${primary.name} and ${secondary.name}`;

  return {
    theme: name,
    themeTag: tags[0],
    // Mash-ups are where Marble is most interesting, so say both plainly.
    worldPrompt: `${primary.world}, fused with ${secondary.world}`,
    enemyPrompt: `${primary.enemy}, fused with elements of ${secondary.enemy}`,
    monumentPrompt: primary.monument,
    composition: [
      primary.waves[0],
      Array.from(new Set([...primary.waves[1], ...secondary.waves[1]])),
      Array.from(new Set([...primary.waves[2], ...secondary.waves[2]])),
    ],
    cardSkins: [
      ...primary.cards.slice(0, 2).map(([slot, n, d]) => ({ slot, name: n, description: d, tag: tags[0] })),
      ...secondary.cards.slice(0, 2).map(([slot, n, d]) => ({ slot, name: n, description: d, tag: tags[1] })),
    ],
  };
}

/**
 * Keywords that map an architect's own words onto a theme tag. The tag never
 * touches the world prompt — it only picks which creature, monument, and card
 * set the floor gets, so a miss is cosmetic rather than broken.
 */
const TAG_WORDS: Array<[ThemeTag, string[]]> = [
  ["fire", ["fire", "lava", "magma", "volcan", "ember", "ash", "burn", "flame", "forge", "furnace", "molten", "scorch", "inferno", "coal", "smoke"]],
  ["ice", ["ice", "frost", "frozen", "snow", "glacier", "arctic", "winter", "cold", "polar", "tundra", "blizzard", "rime"]],
  ["void", ["void", "dark", "shadow", "haunt", "ghost", "night", "grave", "crypt", "abyss", "eldritch", "nightmare", "black", "spectral", "cursed", "moon"]],
  ["nature", ["forest", "jungle", "tree", "moss", "vine", "garden", "grove", "swamp", "flower", "leaf", "overgrown", "meadow", "reef", "coral", "bloom", "root"]],
  ["tech", ["tech", "neon", "cyber", "robot", "machine", "space", "station", "ship", "lab", "reactor", "circuit", "server", "steel", "chrome", "orbital", "hangar", "clockwork", "brass"]],
  ["stone", ["stone", "ruin", "temple", "castle", "marble", "granite", "colosseum", "monastery", "quarry", "cathedral", "pillar", "masonry", "tomb", "hall"]],
];

/**
 * Appended to an architect's prompt. The world model will happily produce a
 * beautiful room with nowhere to stand; the fight needs open ground.
 */
const ARENA_SUFFIX =
  ", wide open walkable floor in the centre, room to move around, no clutter in the middle";

/** The tag whose words appear most often in the architect's text. */
function tagFor(prompt: string, tally: Record<string, number>): ThemeTag {
  const text = prompt.toLowerCase();
  let best: ThemeTag | null = null;
  let bestHits = 0;
  for (const [tag, words] of TAG_WORDS) {
    const hits = words.reduce((n, w) => (text.includes(w) ? n + 1 : n), 0);
    if (hits > bestHits) {
      best = tag;
      bestHits = hits;
    }
  }
  // Nothing recognisable in the text: fall back to what the room voted for.
  return best ?? topTags(tally)[0];
}

/** A short label for the HUD and the ladder, derived from what they wrote. */
function shortName(prompt: string, fallback: string): string {
  const words = prompt
    .replace(/^(a|an|the)\s+/i, "")
    .split(/[,.]/)[0]
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");
  return words.length >= 3 ? words.toLowerCase().slice(0, 40) : fallback;
}

/**
 * A floor written by the player who earned it. Their words go to the world
 * model as-is; everything else — creature, monument, waves, cards — still comes
 * from the deterministic table, so a one-word prompt yields a playable floor.
 */
export function composeFromPrompt(prompt: string, tally: Record<string, number>): Composition {
  const text = prompt.trim().slice(0, 240);
  const tag = tagFor(text, tally);
  const theme = THEMES[tag];

  return {
    theme: shortName(text, theme.name),
    themeTag: tag,
    worldPrompt: `${text}${ARENA_SUFFIX}`,
    enemyPrompt: theme.enemy,
    monumentPrompt: theme.monument,
    composition: theme.waves,
    cardSkins: theme.cards.map(([slot, name, description]) => ({
      slot,
      name,
      description,
      tag,
    })),
  };
}
