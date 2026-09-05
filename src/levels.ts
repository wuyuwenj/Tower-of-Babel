import type { Archetype, ThemeTag } from "./game/balance";
import type { CardSkin } from "./game/cards";

export interface LevelRecord {
  index: number;
  theme: string;
  themeTag: ThemeTag;
  splatUrl: string;
  colliderUrl: string | null;
  enemyUrl: string | null;
  monumentUrl: string | null;
  yOffset: number;
  scale: number;
  composition: Archetype[][] | null;
  cardSkins: CardSkin[] | null;
  status: LevelStatus;
  forgedBy: string | null;
  coForgers: string[];
  tally: Partial<Record<ThemeTag, number>>;
  forgeStartedAt: number | null;
  /** What this floor's architect typed. Null for seed floors and vote-composed ones. */
  prompt: string | null;
  /** Their message, inscribed on the arena floor for everyone who reaches it. */
  message: string | null;
}

export type LevelStatus =
  | "ready"
  | "awaiting"
  | "sealed"
  | "failed"
  | "forging:composing"
  | "forging:world"
  | "forging:creatures";

export const STATUS_LABEL: Record<LevelStatus, string> = {
  ready: "open",
  awaiting: "awaiting its architect",
  sealed: "sealed",
  failed: "forge failed",
  "forging:composing": "composing…",
  "forging:world": "forging world…",
  "forging:creatures": "forging creatures…",
};

export function isForging(status: LevelStatus): boolean {
  return status.startsWith("forging");
}

const BASE = "https://storage.googleapis.com/forge-dev-public/hackathon-260227";

/**
 * Prefer a locally cached copy of a seed world when one exists
 * (`npm run fetch:worlds`). Venue wifi is not something a two-minute demo
 * should depend on, and a local load is roughly ten times faster.
 */
function seedWorld(file: string): string {
  return `/worlds/${file}`;
}

export const REMOTE_SEED_BASE = BASE;

/**
 * Seed rungs so the tower is climbable before anything has been forged.
 * Ordered smallest-download first so a demo never waits on a 300 MB splat.
 */
export const SEED_LEVELS: LevelRecord[] = [
  {
    index: 1,
    theme: "haunted house",
    themeTag: "void",
    splatUrl: seedWorld("haunted-house.spz"),
    colliderUrl: null,
    enemyUrl: null,
    monumentUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
    prompt: null,
    message: null,
  },
  {
    index: 2,
    theme: "cozy ship",
    themeTag: "stone",
    splatUrl: seedWorld("cozy_ship.spz"),
    colliderUrl: null,
    enemyUrl: null,
    monumentUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
    prompt: null,
    message: null,
  },
  {
    index: 3,
    theme: "cozy cottage",
    themeTag: "nature",
    splatUrl: seedWorld("cozy_cottage.spz"),
    colliderUrl: null,
    enemyUrl: null,
    monumentUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
    prompt: null,
    message: null,
  },
  {
    index: 4,
    theme: "derelict spaceship",
    themeTag: "tech",
    splatUrl: seedWorld("cozy-spaceship_2.spz"),
    colliderUrl: null,
    enemyUrl: null,
    monumentUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
    prompt: null,
    message: null,
  },
];
