import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConvexClient } from "convex/browser";
import type { ThemeTag } from "./game/balance";
import { SEED_LEVELS, type LevelRecord, type LevelStatus } from "./levels";
import { playerName, setPlayerName } from "./player-id";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined;

/**
 * The ladder works with or without a Convex deployment.
 *
 * With one, the tower is shared: everyone sees the same rungs, the same theme
 * tally, and the same live forge progress. Without one, it degrades to a
 * single-player tower over the seed levels so the game is always playable —
 * which matters when a demo laptop has no network.
 */
export interface LadderApi {
  levels: LevelRecord[];
  maxCleared: number;
  shared: boolean;
  user: string;
  rename: (name: string) => void;
  recordPick: (levelIndex: number, tag: ThemeTag) => void;
  clearLevel: (levelIndex: number, score: number, timeSeconds: number) => Promise<ClearResult>;
  /** The architect's answer: what the next floor is, and what it says. */
  describeLevel: (levelIndex: number, prompt: string, message: string) => void;
  recordDeath: (levelIndex: number, score: number, timeSeconds: number) => void;
  forgeNow: (tag: ThemeTag) => void;
  leaderboard: (levelIndex: number) => Promise<RunRow[]>;
}

export interface RunRow {
  user: string;
  score: number;
  timeSeconds: number;
}

export interface ClearResult {
  /** This player was the first to clear the frontier, so the monument is theirs. */
  first: boolean;
  /** Whether the next floor is theirs to write — the architect's desk opens. */
  canWrite: boolean;
  /** Who got there first, if someone else did. */
  forgedBy: string | null;
}

let client: ConvexClient | null = null;
function getClient(): ConvexClient | null {
  if (!CONVEX_URL) return null;
  if (!client) client = new ConvexClient(CONVEX_URL);
  return client;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// The generated Convex API only exists after `npx convex dev` has run once, so
// reference functions by name to keep the app buildable before that.
const fn = (name: string) => name as any;

export function useLadder(): LadderApi {
  const convex = useMemo(getClient, []);
  const [user, setUser] = useState(playerName);

  const [levels, setLevels] = useState<LevelRecord[]>(SEED_LEVELS);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const [maxCleared, setMaxCleared] = useState(0);

  // --- shared mode --------------------------------------------------------
  useEffect(() => {
    if (!convex) return;
    convex.mutation(fn("levels:seed"), {}).catch(() => {});
    const unsubLevels = convex.onUpdate(fn("levels:list"), {}, (rows: any[]) => {
      setLevels(rows.map(toRecord));
    });
    const unsubProgress = convex.onUpdate(
      fn("levels:progressFor"),
      { user },
      (n: number) => setMaxCleared(n ?? 0),
    );
    return () => {
      unsubLevels();
      unsubProgress();
    };
  }, [convex, user]);

  const rename = useCallback((name: string) => {
    setPlayerName(name);
    setUser(playerName());
  }, []);

  const recordPick = useCallback(
    (levelIndex: number, tag: ThemeTag) => {
      if (convex) {
        convex.mutation(fn("levels:recordPick"), { levelIndex, tag }).catch(() => {});
        return;
      }
      setLevels((prev) => {
        const frontier = prev.reduce((m, l) => Math.max(m, l.index), 0);
        return prev.map((l) =>
          l.index === frontier
            ? { ...l, tally: { ...l.tally, [tag]: (l.tally[tag] ?? 0) + 1 } }
            : l,
        );
      });
    },
    [convex],
  );

  const clearLevel = useCallback(
    async (levelIndex: number, score: number, timeSeconds: number): Promise<ClearResult> => {
      setMaxCleared((m) => Math.max(m, levelIndex));
      if (!convex) {
        // Offline, you are the only climber: clearing the top floor makes you
        // its architect, so the whole loop is demoable without a network.
        const above = levelsRef.current.find((l) => l.index === levelIndex + 1);
        if (!above) return { first: true, canWrite: true, forgedBy: user };
        return {
          first: false,
          canWrite: above.forgedBy === user && above.status === "awaiting",
          forgedBy: above.forgedBy,
        };
      }
      try {
        const res = await convex.mutation(fn("levels:clearLevel"), {
          levelIndex,
          user,
          score,
          timeSeconds,
        });
        return {
          first: Boolean(res?.first),
          canWrite: Boolean(res?.canWrite),
          forgedBy: res?.forgedBy ?? null,
        };
      } catch {
        return { first: false, canWrite: false, forgedBy: null };
      }
    },
    [convex, user],
  );

  const describeLevel = useCallback(
    (levelIndex: number, prompt: string, message: string) => {
      if (convex) {
        convex
          .mutation(fn("levels:describeLevel"), {
            levelIndex,
            user,
            prompt,
            message: message || undefined,
          })
          .catch(() => {});
        return;
      }
      setLevels((prev) =>
        prev.some((l) => l.index === levelIndex)
          ? prev
          : [
              ...prev,
              {
                ...SEED_LEVELS[0],
                index: levelIndex,
                theme: prompt,
                prompt,
                message: message || null,
                status: "awaiting",
                forgedBy: user,
                coForgers: [],
                tally: {},
                forgeStartedAt: null,
              },
            ],
      );
    },
    [convex, user],
  );

  const recordDeath = useCallback(
    (levelIndex: number, score: number, timeSeconds: number) => {
      if (!convex) return;
      convex.mutation(fn("levels:recordDeath"), { levelIndex, user, score, timeSeconds }).catch(() => {});
    },
    [convex, user],
  );

  const forgeNow = useCallback(
    (tag: ThemeTag) => {
      if (!convex) return;
      convex.mutation(fn("levels:forgeNow"), { tag }).catch(() => {});
    },
    [convex],
  );

  const leaderboard = useCallback(
    async (levelIndex: number): Promise<RunRow[]> => {
      if (!convex) return [];
      try {
        return (await convex.query(fn("levels:leaderboard"), { levelIndex })) ?? [];
      } catch {
        return [];
      }
    },
    [convex],
  );

  return {
    levels,
    maxCleared,
    shared: Boolean(convex),
    user,
    rename,
    recordPick,
    clearLevel,
    describeLevel,
    recordDeath,
    forgeNow,
    leaderboard,
  };
}

function toRecord(row: any): LevelRecord {
  return {
    index: row.index,
    theme: row.theme,
    themeTag: row.themeTag as ThemeTag,
    splatUrl: row.splatUrl ?? SEED_LEVELS[0].splatUrl,
    colliderUrl: row.colliderUrl ?? null,
    enemyUrl: row.enemyUrl ?? null,
    monumentUrl: row.monumentUrl ?? null,
    yOffset: row.yOffset ?? null,
    scale: row.scale ?? 1,
    // Convex seeds rows without an arena radius (and skips rows that already
    // exist), so the hand-tuned seed values have to be resolved client-side.
    arenaRadius:
      row.arenaRadius ??
      (row.seed ? (SEED_LEVELS.find((s) => s.index === row.index)?.arenaRadius ?? null) : null),
    composition: row.composition ?? null,
    cardSkins: row.cardSkins ?? null,
    status: row.status as LevelStatus,
    forgedBy: row.forgedBy ?? null,
    coForgers: row.coForgers ?? [],
    tally: row.tally ?? {},
    forgeStartedAt: row.forgeStartedAt ?? null,
    prompt: row.prompt ?? null,
    message: row.message ?? null,
  };
}
