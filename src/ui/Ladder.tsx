import { THEME_TAGS, type ThemeTag } from "../game/balance";
import { STATUS_LABEL, isForging, type LevelRecord } from "../levels";

interface Props {
  levels: LevelRecord[];
  maxCleared: number;
  onPlay: (level: LevelRecord) => void;
  now: number;
  shared: boolean;
  user: string;
  onForge: (tag: ThemeTag) => void;
}

export function Ladder({ levels, maxCleared, onPlay, now, shared, user, onForge }: Props) {
  const frontier = Math.min(maxCleared + 1, levels.length);

  return (
    <div className="overlay">
      <div className="panel">
        <h1>Tower of Babel</h1>
        <p className="sub">
          A tower with no architect. Every upgrade you pick votes on what the next level becomes —
          and whoever clears the frontier first gets a monument inside it.
        </p>

        <div className="ladder">
          {levels.map((level) => {
            const playable = level.status === "ready" && level.index <= maxCleared + 1;
            const isFrontier = level.index === frontier;
            const tally = Object.entries(level.tally).filter(([, v]) => (v ?? 0) > 0);
            const elapsed =
              level.forgeStartedAt && isForging(level.status)
                ? Math.max(0, Math.floor((now - level.forgeStartedAt) / 1000))
                : null;

            return (
              <button
                key={level.index}
                className={[
                  "rung",
                  playable ? "playable" : "locked",
                  isFrontier ? "frontier" : "",
                ].join(" ")}
                disabled={!playable}
                onClick={() => playable && onPlay(level)}
              >
                <div className="idx">{level.index}</div>
                <div>
                  <div className="theme">{level.theme}</div>
                  <div className="meta">
                    {level.forgedBy
                      ? `Forged by ${level.forgedBy}${
                          level.coForgers.length ? ` · with ${level.coForgers.join(", ")}` : ""
                        }`
                      : isFrontier
                        ? "The frontier — nobody has cleared this yet"
                        : "Seed level"}
                  </div>
                  {tally.length > 0 && (
                    <div className="tally">
                      {tally.map(([tag, count]) => (
                        <span key={tag}>
                          {tag} {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="state">
                  {STATUS_LABEL[level.status]}
                  {elapsed !== null && (
                    <div style={{ opacity: 0.7 }}>
                      {Math.floor(elapsed / 60)}m {(elapsed % 60).toString().padStart(2, "0")}s
                    </div>
                  )}
                  {level.index > maxCleared + 1 && level.status === "ready" && (
                    <div style={{ opacity: 0.7 }}>clear {level.index - 1} first</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="row">
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {shared ? "Shared tower" : "Local tower — run `npx convex dev` to share it"} · you are{" "}
            <strong style={{ color: "var(--gold)" }}>{user}</strong>
          </span>
          <div className="spacer" />
          {shared && (
            <>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>force a forge:</span>
              {THEME_TAGS.map((tag) => (
                <button key={tag} className="ghost" onClick={() => onForge(tag)}>
                  {tag}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
