import { useCallback, useEffect, useMemo, useState } from "react";
import { ConvexClient } from "convex/browser";
import type { ThemeTag } from "./game/balance";
import { SEED_LEVELS, type LevelRecord, type LevelStatus } from "./levels";
import { playerName } from "./player-id";

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
  recordPick: (levelIndex: number, tag: ThemeTag) => void;
  reachedBoss: (levelIndex: number) => void;
  clearLevel: (levelIndex: number, score: number, timeSeconds: number) => Promise<string | null>;
  recordDeath: (levelIndex: number, score: number, timeSeconds: number) => void;
  forgeNow: (tag: ThemeTag) => void;
  leaderboard: (levelIndex: number) => Promise<RunRow[]>;
}

export interface RunRow {
  user: string;
  score: number;
  timeSeconds: number;
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
  const user = useMemo(playerName, []);

  const [levels, setLevels] = useState<LevelRecord[]>(SEED_LEVELS);
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

  const reachedBoss = useCallback(
    (levelIndex: number) => {
      if (!convex) return;
      convex.mutation(fn("levels:reachedBoss"), { levelIndex }).catch(() => {});
    },
    [convex],
  );

  const clearLevel = useCallback(
    async (levelIndex: number, score: number, timeSeconds: number) => {
      setMaxCleared((m) => Math.max(m, levelIndex));
      if (!convex) return null;
      try {
        const res = await convex.mutation(fn("levels:clearLevel"), {
          levelIndex,
          user,
          score,
          timeSeconds,
        });
        return res?.first ? user : (res?.forgedBy ?? null);
      } catch {
        return null;
      }
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
    recordPick,
    reachedBoss,
    clearLevel,
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
    yOffset: row.yOffset ?? 0,
    scale: row.scale ?? 1,
    composition: row.composition ?? null,
    cardSkins: row.cardSkins ?? null,
    status: row.status as LevelStatus,
    forgedBy: row.forgedBy ?? null,
    coForgers: row.coForgers ?? [],
    tally: row.tally ?? {},
    forgeStartedAt: row.forgeStartedAt ?? null,
  };
}
