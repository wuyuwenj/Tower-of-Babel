import { useCallback, useEffect, useRef, useState } from "react";
import { Game, type CardOffer } from "./game";
import type { ThemeTag } from "./game/balance";
import type { LevelRecord } from "./levels";
import { useLadder } from "./useLadder";
import { Cards } from "./ui/Cards";
import { ClearScreen } from "./ui/ClearScreen";
import { Hud } from "./ui/Hud";
import { Ladder } from "./ui/Ladder";

type Phase = "ladder" | "loading" | "playing" | "ended";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const currentRef = useRef<LevelRecord | null>(null);

  const ladder = useLadder();
  const ladderRef = useRef(ladder);
  ladderRef.current = ladder;

  const [phase, setPhase] = useState<Phase>("ladder");
  const [current, setCurrent] = useState<LevelRecord | null>(null);
  const [loadStage, setLoadStage] = useState("Preparing");

  const [hp, setHp] = useState({ hp: 100, maxHp: 100 });
  const [xp, setXp] = useState({ xp: 0, needed: 8, level: 1 });
  const [wave, setWave] = useState({ wave: 1, wavesPerLevel: 3, remaining: 0 });
  const [boss, setBoss] = useState<{ hp: number; maxHp: number } | null>(null);
  const [fps, setFps] = useState(0);
  const [offers, setOffers] = useState<CardOffer[] | null>(null);
  const [result, setResult] = useState<{
    cleared: boolean;
    levelIndex: number;
    score: number;
    timeSeconds: number;
    message: string | null;
  } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!canvasRef.current) return;

    Game.create(canvasRef.current).then((game) => {
      if (disposed) {
        game.dispose();
        return;
      }
      gameRef.current = game;

      game.bus.on("hp", setHp);
      game.bus.on("xp", setXp);
      game.bus.on("boss", setBoss);
      game.bus.on("fps", (f) => setFps(f.value));
      game.bus.on("loading", (l) => setLoadStage(l.stage));
      game.bus.on("levelup", (e) => setOffers(e.offers));

      game.bus.on("wave", (w) => {
        setWave(w);
        // The forge starts the moment the first player reaches the boss, so the
        // ~5 minute generation lands about when someone finishes the level.
        if (w.wave >= w.wavesPerLevel && currentRef.current) {
          ladderRef.current.reachedBoss(currentRef.current.index);
        }
      });

      game.bus.on("pick", (e) => {
        if (currentRef.current) ladderRef.current.recordPick(currentRef.current.index, e.tag);
      });

      game.bus.on("clear", async (e) => {
        setResult({ ...e, cleared: true, message: null });
        setPhase("ended");
        const owner = await ladderRef.current.clearLevel(e.levelIndex, e.score, e.timeSeconds);
        setResult((r) =>
          r
            ? {
                ...r,
                message:
                  owner === ladderRef.current.user
                    ? `You reached the frontier first. Level ${e.levelIndex + 1} carries your monument.`
                    : owner
                      ? `${owner} got here first — you are on the plaque of level ${e.levelIndex + 1}.`
                      : null,
              }
            : r,
        );
      });

      game.bus.on("death", (e) => {
        setResult({ ...e, cleared: false, message: null });
        setPhase("ended");
        ladderRef.current.recordDeath(e.levelIndex, e.score, e.timeSeconds);
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
      enemyUrl: level.enemyUrl,
      monumentUrl: level.monumentUrl,
      forgedBy: level.forgedBy,
      coForgers: level.coForgers,
      yOffset: level.yOffset,
      scale: level.scale,
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

  return (
    <>
      <canvas ref={canvasRef} />

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
          onQuit={toLadder}
        />
      )}

      {offers && <Cards offers={offers} onPick={pick} />}

      {phase === "loading" && (
        <div className="loading">
          <div className="title">Tower of Babel</div>
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
          onForge={forge}
        />
      )}

      {phase === "ended" && result && (
        <ClearScreen
          cleared={result.cleared}
          levelIndex={result.levelIndex}
          score={result.score}
          timeSeconds={result.timeSeconds}
          message={result.message}
          onRetry={() => current && play(current)}
          onLadder={toLadder}
        />
      )}
    </>
  );
}
