import type { Archetype, ThemeTag } from "./game/balance";
import type { CardSkin } from "./game/cards";

export interface LevelRecord {
  index: number;
  theme: string;
  themeTag: ThemeTag;
  splatUrl: string;
  colliderUrl: string | null;
  yOffset: number;
  scale: number;
  composition: Archetype[][] | null;
  cardSkins: CardSkin[] | null;
  status: LevelStatus;
  forgedBy: string | null;
  coForgers: string[];
  tally: Partial<Record<ThemeTag, number>>;
  forgeStartedAt: number | null;
}

export type LevelStatus =
  | "ready"
  | "sealed"
  | "failed"
  | "forging:composing"
  | "forging:world"
  | "forging:creatures";

export const STATUS_LABEL: Record<LevelStatus, string> = {
  ready: "open",
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
 * Seed rungs so the tower is climbable before anything has been forged.
 * Ordered smallest-download first so a demo never waits on a 300 MB splat.
 */
export const SEED_LEVELS: LevelRecord[] = [
  {
    index: 1,
    theme: "haunted house",
    themeTag: "void",
    splatUrl: `${BASE}/haunted-house.spz`,
    colliderUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
  },
  {
    index: 2,
    theme: "cozy ship",
    themeTag: "stone",
    splatUrl: `${BASE}/cozy_ship.spz`,
    colliderUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
  },
  {
    index: 3,
    theme: "cozy cottage",
    themeTag: "nature",
    splatUrl: `${BASE}/cozy_cottage.spz`,
    colliderUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
  },
  {
    index: 4,
    theme: "derelict spaceship",
    themeTag: "tech",
    splatUrl: `${BASE}/cozy-spaceship_2.spz`,
    colliderUrl: null,
    yOffset: 0,
    scale: 1,
    composition: null,
    cardSkins: null,
    status: "ready",
    forgedBy: null,
    coForgers: [],
    tally: {},
    forgeStartedAt: null,
  },
];
