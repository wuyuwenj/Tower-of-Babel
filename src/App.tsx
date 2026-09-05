import { useCallback, useEffect, useRef, useState } from "react";
import { Game, type CardOffer } from "./game";
import type { ThemeTag } from "./game/balance";
import { SEED_LEVELS, type LevelRecord } from "./levels";
import { Cards } from "./ui/Cards";
import { ClearScreen } from "./ui/ClearScreen";
import { Hud } from "./ui/Hud";
import { Ladder } from "./ui/Ladder";

type Phase = "ladder" | "loading" | "playing" | "ended";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [phase, setPhase] = useState<Phase>("ladder");
  const [levels, setLevels] = useState<LevelRecord[]>(SEED_LEVELS);
  const [maxCleared, setMaxCleared] = useState(0);
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
      game.bus.on("wave", setWave);
      game.bus.on("boss", setBoss);
      game.bus.on("fps", (f) => setFps(f.value));
      game.bus.on("loading", (l) => setLoadStage(l.stage));
      game.bus.on("levelup", (e) => setOffers(e.offers));
      game.bus.on("pick", (e) => recordPick(e.tag));
      game.bus.on("clear", (e) => {
        setResult({ ...e, cleared: true, message: null });
        setPhase("ended");
        onCleared(e.levelIndex, e.score);
      });
      game.bus.on("death", (e) => {
        setResult({ ...e, cleared: false, message: null });
        setPhase("ended");
      });
    });
    return () => {
      disposed = true;
      gameRef.current?.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Every upgrade pick votes on the frontier level's theme. */
  const recordPick = useCallback((tag: ThemeTag) => {
    setLevels((prev) => {
      const frontierIndex = prev.reduce((m, l) => Math.max(m, l.index), 0);
      return prev.map((l) =>
        l.index === frontierIndex
          ? { ...l, tally: { ...l.tally, [tag]: (l.tally[tag] ?? 0) + 1 } }
          : l,
      );
    });
  }, []);

  const onCleared = useCallback((levelIndex: number, _score: number) => {
    setMaxCleared((m) => Math.max(m, levelIndex));
  }, []);

  const play = useCallback(async (level: LevelRecord) => {
    const game = gameRef.current;
    if (!game) return;
    setCurrent(level);
    setOffers(null);
    setResult(null);
    setPhase("loading");
    await game.loadLevel({
      levelIndex: level.index,
      themeTag: level.themeTag,
      splatUrl: level.splatUrl,
      colliderUrl: level.colliderUrl,
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
        <Ladder levels={levels} maxCleared={maxCleared} onPlay={play} now={now} />
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
