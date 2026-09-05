import {
  BASE_PLAYER,
  CARD_SLOTS,
  CARD_TIERS,
  THEME_COLOR,
  type CardSlot,
  type PlayerStats,
  type ThemeTag,
} from "./balance";

export interface CardSkin {
  slot: CardSlot;
  name: string;
  description: string;
  tag: ThemeTag;
}

export interface CardOffer extends CardSkin {
  tier: number; // 1-based
  color: number;
}

// Hand-tuned opening offers so the first 90 seconds of any demo are good.
export const OPENING_SKINS: CardSkin[][] = [
  [
    { slot: "damage", name: "Sharpened Edge", description: "+5 damage", tag: "stone" },
    { slot: "utility", name: "Light Step", description: "+speed, wider pickup", tag: "nature" },
    { slot: "defense", name: "Worn Plating", description: "+25 max HP, slow regen", tag: "stone" },
  ],
  [
    { slot: "area", name: "Shockwave", description: "Attacks splash nearby foes", tag: "tech" },
    { slot: "damage", name: "Heavy Strike", description: "+5 damage", tag: "fire" },
    { slot: "utility", name: "Quick Hands", description: "+speed, wider pickup", tag: "tech" },
  ],
  [
    { slot: "damage", name: "Killing Intent", description: "+damage, faster attacks", tag: "void" },
    { slot: "area", name: "Wide Arc", description: "Bigger splash, longer reach", tag: "ice" },
    { slot: "defense", name: "Second Wind", description: "+50 max HP, regen", tag: "nature" },
  ],
];

const FALLBACK_SKINS: Record<CardSlot, CardSkin> = {
  damage: { slot: "damage", name: "Honed Fang", description: "More damage", tag: "stone" },
  area: { slot: "area", name: "Rippling Blow", description: "Wider splash", tag: "tech" },
  utility: { slot: "utility", name: "Fleet Boots", description: "Faster, wider pickup", tag: "nature" },
  defense: { slot: "defense", name: "Iron Hide", description: "More HP and regen", tag: "stone" },
};

export function applyCard(stats: PlayerStats, offer: CardOffer): PlayerStats {
  const delta = CARD_TIERS[offer.slot][offer.tier - 1];
  const next: PlayerStats = { ...stats };
  for (const [k, v] of Object.entries(delta) as Array<[keyof PlayerStats, number]>) {
    next[k] = next[k] + v;
  }
  next.attackCooldown = Math.max(0.12, next.attackCooldown);
  return next;
}

function tierForPlayerLevel(playerLevel: number): number {
  if (playerLevel >= 8) return 3;
  if (playerLevel >= 4) return 2;
  return 1;
}

/** Build three distinct offers. Skins are cosmetic; tiers come from balance.ts. */
export function rollOffers(playerLevel: number, skins: CardSkin[] | null): CardOffer[] {
  const tier = tierForPlayerLevel(playerLevel);

  const opening = OPENING_SKINS[playerLevel - 1];
  const pool = opening ?? skins ?? null;

  let chosen: CardSkin[];
  if (pool && pool.length >= 3) {
    chosen = shuffle(pool).slice(0, 3);
  } else {
    chosen = shuffle([...CARD_SLOTS]).slice(0, 3).map((slot) => FALLBACK_SKINS[slot]);
  }

  // Guarantee three distinct slots so an offer is never three of the same thing.
  const used = new Set<CardSlot>();
  chosen = chosen.map((skin) => {
    if (!used.has(skin.slot)) {
      used.add(skin.slot);
      return skin;
    }
    const free = CARD_SLOTS.find((s) => !used.has(s))!;
    used.add(free);
    return { ...FALLBACK_SKINS[free], tag: skin.tag };
  });

  return chosen.map((skin) => ({ ...skin, tier, color: THEME_COLOR[skin.tag] }));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const BASE_STATS = BASE_PLAYER;
