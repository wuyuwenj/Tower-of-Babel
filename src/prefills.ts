import { THEME_TAGS, type ThemeTag } from "./game/balance";

export const MAX_PROMPT = 240;
export const MAX_MESSAGE = 80;

/**
 * Suggested floors for an architect who would rather not think. Each one is
 * written the way the world model likes it — materials, light, scale, and a
 * wide open floor to fight on — so a player who just hits "Forge" still gets a
 * good level.
 */
const PREFILLS: Record<ThemeTag, string[]> = {
  fire: [
    "a scorched volcanic basin at dusk, cracked obsidian ground, lava vents glowing orange, ash drifting through the air, wide open floor",
    "a foundry hall abandoned mid-pour, rivers of cooling slag in stone channels, iron gantries overhead, embers falling, wide flat floor",
    "a desert temple built over a sleeping caldera, sandstone pillars scorched black, a glowing fissure splitting the courtyard, wide open floor",
    "a burning library, shelves collapsed into cinders, pages drifting in the heat, a cracked marble floor open in the center",
    "a dragon's roost of black basalt, heaps of melted gold, red light rising from vents below, a wide flat ledge",
  ],
  ice: [
    "a windswept glacier field under pale blue light, fractured ice shelves, frozen pillars, drifting snow, a wide flat basin",
    "a frozen harbor town at night, ships locked in the ice, lanterns glowing through frosted windows, an open snowy square",
    "a cathedral carved from ice inside a mountain, translucent blue columns, light bleeding through the walls, a wide nave",
    "an arctic research station half buried in snow, steel walls frosted over, aurora overhead, a cleared open landing pad",
    "a frozen waterfall over a hollow cavern, icicles the size of towers, blue light glowing from the ice, a wide flat floor",
  ],
  void: [
    "a derelict haunted manor at night, warped wooden floors, broken furniture, dust in shafts of moonlight, a wide hall",
    "a drowned cathedral lit by bioluminescent jellyfish, flooded stone floor, toppled pews, a wide open nave",
    "a graveyard on a floating island, crooked headstones, purple mist, one dead tree in the center, wide open ground",
    "an abandoned carnival at midnight, a rusted ferris wheel, torn tents, flickering bulbs, a wide trampled field",
    "a temple where the floor is black glass reflecting a starless sky, shards of stone floating overhead, a wide open circle",
  ],
  nature: [
    "a sunlit forest clearing deep in an overgrown valley, mossy stone ruins, thick tree trunks, hanging vines, a wide grassy floor",
    "the inside of a giant hollow tree, walls of bark, faintly glowing mushrooms, roots forming arches, a wide floor of packed earth",
    "terraced rice paddies on a mountainside at golden hour, shallow water reflecting the sky, one wide dry terrace",
    "an overgrown greenhouse with a shattered glass roof, vines swallowing the iron frames, a wide stone floor",
    "a coral reef exposed at low tide, walls of pink and orange coral, pools of clear water, a wide sandy floor",
  ],
  tech: [
    "the interior of an abandoned spacecraft hangar, scuffed metal decking, exposed cabling, flickering panel lights, a wide open bay",
    "a neon-lit rooftop in a rain-soaked megacity, holographic billboards, humming vents, a wide flat helipad",
    "a server farm gone dark, endless racks with a few blinking lights, cold blue emergency lighting, a wide central aisle",
    "a derelict orbital station with a cracked viewport onto a gas giant, debris drifting, a wide open deck",
    "a clockwork bazaar suspended over a canyon, brass gears turning in the walls, steam venting, a wide plank floor",
  ],
  stone: [
    "a vast ruined stone hall half sunk in shallow water, toppled columns, carved masonry, light from a broken ceiling, a wide flooded floor",
    "a colosseum at dawn, a sand floor, cracked stone tiers, banners in tatters, a wide open arena",
    "a mountain monastery courtyard above the clouds, prayer flags, worn flagstones, a wide open square",
    "an ancient quarry, terraced cliffs of pale limestone, abandoned tools, a wide flat cut floor",
    "a stone circle on a moor at dusk, standing stones taller than houses, mist at knee height, a wide open ring",
  ],
};

/**
 * Votes tilt the draw without deciding it: a floor the room leaned "fire"
 * suggests fire more often, but every theme stays reachable with a refresh.
 */
export function pickPrefill(tally: Partial<Record<ThemeTag, number>>, avoid?: string): string {
  const weights = THEME_TAGS.map((t) => 1 + 2 * Math.min(tally[t] ?? 0, 5));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let tag: ThemeTag = THEME_TAGS[0];
  for (let i = 0; i < THEME_TAGS.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      tag = THEME_TAGS[i];
      break;
    }
  }
  const pool = PREFILLS[tag].filter((p) => p !== avoid);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The tags the room actually voted for, strongest first. */
export function leaning(tally: Partial<Record<ThemeTag, number>>): Array<[ThemeTag, number]> {
  return THEME_TAGS.map((t) => [t, tally[t] ?? 0] as [ThemeTag, number])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}
