import { useCallback, useEffect, useRef, useState } from "react";
import { Game, type CardOffer } from "./game";
import { rollOffers } from "./game/cards";
import type { ThemeTag } from "./game/balance";
import { SEED_LEVELS, STATUS_LABEL, isForging, type LevelRecord } from "./levels";
import { useLadder, type RunRow } from "./useLadder";
import { Cards } from "./ui/Cards";
import { ClearScreen } from "./ui/ClearScreen";
import { Hud } from "./ui/Hud";
import { Ladder } from "./ui/Ladder";

type Phase = "ladder" | "loading" | "playing" | "ended";

interface RunResult {
  cleared: boolean;
  /** Was first to clear it, so the monument above is theirs. */
  first: boolean;
  /** The floor above is theirs to write — the architect's desk opens. */
  canWrite: boolean;
  levelIndex: number;
  score: number;
  timeSeconds: number;
  message: string | null;
  /** When the tower forges the next floor without its architect. */
  deadline: number | null;
}

/** How long the first clearer has to write the next floor before it forges itself. */
const ARCHITECT_SECONDS = 120;

// ?preview=architect opens straight onto the architect's desk so the screen
// can be styled and rehearsed without clearing a floor first.
const PREVIEW = new URLSearchParams(location.search).get("preview");
const PREVIEW_RESULT: RunResult | null =
  PREVIEW === "architect"
    ? {
        cleared: true,
        first: true,
        canWrite: true,
        levelIndex: 4,
        score: 1480,
        timeSeconds: 203,
        message: null,
        deadline: Date.now() + ARCHITECT_SECONDS * 1000,
      }
    : null;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const currentRef = useRef<LevelRecord | null>(null);

  const ladder = useLadder();
  const ladderRef = useRef(ladder);
  ladderRef.current = ladder;

  // ?preview=cards / ?preview=hud render the play-time chrome over an empty
  // scene, so it can be styled without surviving three waves first.
  const [phase, setPhase] = useState<Phase>(
    PREVIEW_RESULT ? "ended" : PREVIEW === "cards" || PREVIEW === "hud" ? "playing" : "ladder",
  );
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<LevelRecord | null>(PREVIEW === "hud" ? SEED_LEVELS[3] : null);
  const [loadStage, setLoadStage] = useState("Preparing");

  const [hp, setHp] = useState(PREVIEW === "hud" ? { hp: 64, maxHp: 118 } : { hp: 100, maxHp: 100 });
  const [xp, setXp] = useState(PREVIEW === "hud" ? { xp: 11, needed: 19, level: 4 } : { xp: 0, needed: 8, level: 1 });
  const [wave, setWave] = useState(PREVIEW === "hud" ? { wave: 3, wavesPerLevel: 3, remaining: 7 } : { wave: 1, wavesPerLevel: 3, remaining: 0 });
  const [boss, setBoss] = useState<{ hp: number; maxHp: number } | null>(
    PREVIEW === "hud" ? { hp: 540, maxHp: 900 } : null,
  );
  const [fps, setFps] = useState(0);
  // ?preview=cards shows a hand of upgrades without earning one, for styling.
  const [offers, setOffers] = useState<CardOffer[] | null>(
    PREVIEW === "cards" ? rollOffers(3, null) : null,
  );
  const [result, setResult] = useState<RunResult | null>(PREVIEW_RESULT);
  const [now, setNow] = useState(Date.now());
  const [runs, setRuns] = useState<RunRow[]>([]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Deep link: ?level=3 drops straight into a rung. Handy for demos and for
  // screenshotting a specific world without clicking through the ladder.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !ready || ladder.levels.length === 0) return;
    const wanted = Number(new URLSearchParams(location.search).get("level"));
    if (!wanted) return;
    const level = ladder.levels.find((l) => l.index === wanted);
    if (!level) return;
    autoStarted.current = true;
    void play(level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ladder.levels]);

  useEffect(() => {
    let disposed = false;
    if (!canvasRef.current) return;

    Game.create(canvasRef.current).then((game) => {
      if (disposed) {
        game.dispose();
        return;
      }
      gameRef.current = game;
      setReady(true);

      game.bus.on("hp", setHp);
      game.bus.on("xp", setXp);
      game.bus.on("boss", setBoss);
      game.bus.on("fps", (f) => setFps(f.value));
      game.bus.on("loading", (l) => setLoadStage(l.stage));
      game.bus.on("levelup", (e) => setOffers(e.offers));

      game.bus.on("wave", setWave);

      game.bus.on("pick", (e) => {
        if (currentRef.current) ladderRef.current.recordPick(currentRef.current.index, e.tag);
      });

      game.bus.on("clear", async (e) => {
        setResult({ ...e, cleared: true, first: false, canWrite: false, message: null, deadline: null });
        setPhase("ended");
        const res = await ladderRef.current.clearLevel(e.levelIndex, e.score, e.timeSeconds);
        void ladderRef.current.leaderboard(e.levelIndex).then(setRuns);
        setResult((r) =>
          r
            ? {
                ...r,
                first: res.first,
                canWrite: res.canWrite,
                deadline: res.canWrite ? Date.now() + ARCHITECT_SECONDS * 1000 : null,
                message:
                  !res.first && res.forgedBy
                    ? `${res.forgedBy} got here first — you're on the plaque of floor ${e.levelIndex + 1}.`
                    : null,
              }
            : r,
        );
      });

      game.bus.on("death", (e) => {
        setResult({ ...e, cleared: false, first: false, canWrite: false, message: null, deadline: null });
        setPhase("ended");
        ladderRef.current.recordDeath(e.levelIndex, e.score, e.timeSeconds);
        void ladderRef.current.leaderboard(e.levelIndex).then(setRuns);
      });
    });

    return () => {
      disposed = true;
      gameRef.current?.dispose();
      gameRef.current = null;
    };
  }, []);

  const play = useCallback(async (level: LevelRecord) => {
    const game = gameRef.current;
    if (!game) return;
    currentRef.current = level;
    setCurrent(level);
    setOffers(null);
    setResult(null);
    setPhase("loading");
    await game.loadLevel({
      levelIndex: level.index,
      themeTag: level.themeTag,
      splatUrl: level.splatUrl,
      colliderUrl: level.colliderUrl,
      // ?enemy=/creatures/foo.glb previews a creature without forging a level.
      enemyUrl: new URLSearchParams(location.search).get("enemy") ?? level.enemyUrl,
      monumentUrl: level.monumentUrl,
      forgedBy: level.forgedBy,
      coForgers: level.coForgers,
      message: level.message,
      yOffset: level.yOffset ?? undefined,
      scale: level.scale,
      arenaRadius: level.arenaRadius ?? undefined,
      ceilingCut: level.ceilingCut,
      composition: level.composition,
      cardSkins: level.cardSkins,
    });
    setPhase("playing");
  }, []);

  const pick = useCallback((offer: CardOffer) => {
    setOffers(null);
    gameRef.current?.choose(offer);
  }, []);

  const toLadder = useCallback(() => {
    setPhase("ladder");
    setOffers(null);
    setResult(null);
  }, []);

  const forge = useCallback((tag: ThemeTag) => ladder.forgeNow(tag), [ladder]);

  const describe = useCallback(
    (prompt: string, message: string) => {
      if (result) ladder.describeLevel(result.levelIndex + 1, prompt, message);
    },
    [ladder, result],
  );

  const clearedLevel = result ? ladder.levels.find((l) => l.index === result.levelIndex) : undefined;

  // While you fight, the next rung is being built from the room's votes.
  const forging = (() => {
    if (PREVIEW === "hud") return { index: 5, theme: "ember wastes", stage: "forging", elapsed: 214 };
    const level = ladder.levels.find((l) => isForging(l.status));
    if (!level) return null;
    return {
      index: level.index,
      theme: level.theme,
      stage: STATUS_LABEL[level.status],
      elapsed: Math.max(0, Math.floor((now - (level.forgeStartedAt ?? now)) / 1000)),
    };
  })();

  return (
    <>
      <canvas ref={canvasRef} />

      {phase === "playing" && <div className="vignette" />}

      {phase === "playing" && current && (
        <Hud
          hp={hp.hp}
          maxHp={hp.maxHp}
          xp={xp.xp}
          xpNeeded={xp.needed}
          playerLevel={xp.level}
          wave={wave.wave}
          wavesPerLevel={wave.wavesPerLevel}
          remaining={wave.remaining}
          levelIndex={current.index}
          themeLabel={current.theme}
          boss={boss}
          fps={fps}
          forging={forging}
          onQuit={toLadder}
        />
      )}

      {offers && <Cards offers={offers} onPick={pick} />}

      {phase === "loading" && current && (
        <div className="loading">
          <div className="title">Tower of Babel</div>
          <div className="floor">
            Floor {current.index} · {current.prompt ?? current.theme}
          </div>
          {current.message && current.forgedBy && (
            <div className="inscription">
              “{current.message}” — {current.forgedBy}
            </div>
          )}
          <div>{loadStage}…</div>
        </div>
      )}

      {phase === "ladder" && (
        <Ladder
          levels={ladder.levels}
          maxCleared={ladder.maxCleared}
          onPlay={play}
          now={now}
          shared={ladder.shared}
          user={ladder.user}
          onRename={ladder.rename}
          onForge={forge}
        />
      )}

      {phase === "ended" && result && (
        <ClearScreen
          cleared={result.cleared}
          first={result.first}
          canWrite={result.canWrite}
          runs={runs}
          user={ladder.user}
          levelIndex={result.levelIndex}
          score={result.score}
          timeSeconds={result.timeSeconds}
          message={result.message}
          tally={clearedLevel?.tally ?? {}}
          deadline={result.deadline}
          now={now}
          onForge={describe}
          onRetry={() => current && play(current)}
          onLadder={toLadder}
        />
      )}
    </>
  );
}
