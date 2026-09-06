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
  /** null = measure the floor from the splat cloud, which is nearly always right. */
  yOffset: number | null;
  scale: number;
  /** Invisible wall radius. null = the balance.ts default. Tune with ?arena=N. */
  arenaRadius: number | null;
  /** Height above the floor to cut the world away at. Unset = the world.ts default; null = no cut. */
  ceilingCut?: number | null;
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
  awaiting: "awaiting architect",
  sealed: "sealed",
  failed: "forge failed",
  "forging:composing": "forging",
  "forging:world": "forging",
  "forging:creatures": "forging",
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
const WORLD_REMOTES = new Map<string, string>();

/** Register a seed world: served from the local cache, fetched from `remote` when absent. */
function seedWorld(file: string, remote = `${BASE}/${file}`): string {
  const local = `/worlds/${file}`;
  WORLD_REMOTES.set(local, remote);
  return local;
}

/** Where a `/worlds/...` path can be fetched from when the local cache is empty. */
export function remoteWorldUrl(local: string): string | undefined {
  return WORLD_REMOTES.get(local);
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
    yOffset: null,
    scale: 4,
    arenaRadius: 13,
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
    yOffset: null,
    scale: 3,
    arenaRadius: 13,
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
    yOffset: null,
    scale: 1,
    arenaRadius: 7,
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
    yOffset: null,
    scale: 2,
    arenaRadius: 10,
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
