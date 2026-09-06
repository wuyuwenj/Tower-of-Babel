import { useState, type ReactNode } from "react";
import { THEME_TAGS, type ThemeTag } from "../game/balance";
import { STATUS_LABEL, isForging, type LevelRecord, type LevelStatus } from "../levels";

interface Props {
  levels: LevelRecord[];
  maxCleared: number;
  onPlay: (level: LevelRecord) => void;
  now: number;
  shared: boolean;
  user: string;
  onRename: (name: string) => void;
  onForge: (tag: ThemeTag) => void;
}

/** `?dev` shows the force-forge buttons; to anyone else they are noise. */
const DEV = new URLSearchParams(location.search).has("dev");

/**
 * The landing screen. There is no separate splash: the tower explains itself.
 * Other people's names on the floors are the pitch, the frontier rung is the
 * call to action, and the unwritten floor above it is the promise.
 */
export function Ladder({ levels, maxCleared, onPlay, now, shared, user, onRename, onForge }: Props) {
  const top = levels.reduce((m, l) => Math.max(m, l.index), 0);
  // The frontier is the highest floor anyone can enter. Rows above it are
  // still being written or forged.
  const frontier = levels.reduce((m, l) => (l.status === "ready" ? Math.max(m, l.index) : m), 0);
  const above = levels.find((l) => l.index === frontier + 1) ?? null;
  // The floor this player climbs next: their checkpoint, capped at the frontier.
  const next = Math.min(maxCleared + 1, frontier);
  const nextLevel = levels.find((l) => l.index === next) ?? null;

  return (
    <div className="overlay">
      <div className="panel start">
        <header className="hero">
          <div>
            <div className="kicker">Tower of Babel · Chapter the first · the ascent</div>
            <h1>A tower with no architect.</h1>
            <p className="sub">Climb it. The top is yours to build.</p>
          </div>
          {nextLevel && (
            <button className="primary climb" onClick={() => onPlay(nextLevel)}>
              {next <= maxCleared ? "Climb again" : "Climb"} ▶ floor {next}
            </button>
          )}
        </header>

        <ol className="steps">
          <Step n="01" title="Climb">
            WASD. Survive three waves and the boss.
          </Step>
          <Step n="02" title="Take the top">
            The highest floor is the frontier. Nobody has beaten it yet.
          </Step>
          <Step n="03" title="Build the next floor">
            First to clear it writes what comes next. AI forges it, everyone climbs it — and reads
            the message you left on its floor.
          </Step>
        </ol>

        <div className="ladder">
          {levels.map((level) => (
            <Rung
              key={level.index}
              level={level}
              frontier={frontier}
              above={above}
              maxCleared={maxCleared}
              next={next}
              now={now}
              onPlay={onPlay}
            />
          ))}
          {!above && <GhostRung floor={top + 1} below={frontier} />}
        </div>

        <footer className="row foot">
          <NameTag user={user} onRename={onRename} />
          <span className="dot">·</span>
          <span>{shared ? "Shared tower" : "Local tower — run `npx convex dev` to share it"}</span>
          <div className="spacer" />
          <span className="sheet">written by whoever climbs highest</span>
          {DEV && shared && (
            <>
              <span>force a forge:</span>
              {THEME_TAGS.map((tag) => (
                <button key={tag} className="ghost" onClick={() => onForge(tag)}>
                  {tag}
                </button>
              ))}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="n">{n}</span>
      <div>
        <b>{title}</b>
        <span>{children}</span>
      </div>
    </li>
  );
}

interface RungProps {
  level: LevelRecord;
  frontier: number;
  above: LevelRecord | null;
  maxCleared: number;
  next: number;
  now: number;
  onPlay: (level: LevelRecord) => void;
}

function Rung({ level, frontier, above, maxCleared, next, now, onPlay }: RungProps) {
  const isFrontier = level.index === frontier;
  const pending = level.status !== "ready";
  // `?dev` lifts the progression gate so any forged floor can be entered
  // without climbing to it — the point is to inspect a world, not to earn it.
  // A pending floor stays locked either way: it has no splat to load yet.
  const playable = !pending && (DEV || level.index <= maxCleared + 1);
  const isNext = playable && level.index === next;
  const elapsed =
    level.forgeStartedAt && isForging(level.status)
      ? Math.max(0, Math.floor((now - level.forgeStartedAt) / 1000))
      : null;
  // Votes only explain a floor nobody wrote. Once an architect has spoken,
  // the tally is just noise attached to the wrong rung.
  const votes = level.prompt
    ? []
    : Object.entries(level.tally)
        .filter(([, n]) => (n ?? 0) > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  return (
    <button
      className={[
        "rung",
        playable ? "playable" : "locked",
        isFrontier ? "frontier" : "",
        pending ? "pending" : "",
        isForging(level.status) ? "hatch" : "",
      ].join(" ")}
      disabled={!playable}
      onClick={() => playable && onPlay(level)}
    >
      <div className="idx">{pad(level.index)}</div>
      <div>
        <div className="theme">
          {isFrontier && <span className="tag">◆ frontier</span>}
          {cap(clip(level.prompt ?? level.theme, 72))}
        </div>
        <div className="meta">{describe(level, isFrontier, above)}</div>
        {level.message && level.forgedBy && (
          <div className="quote">
            “{level.message}” <b>— {level.forgedBy}</b>
          </div>
        )}
        {votes.length > 0 && (
          <div className="tally">
            {votes.map(([tag, n]) => (
              <span key={tag}>
                {tag} {n}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="state">
        {pending ? (
          <>
            <span className={`stamp ${stampTone(level.status)}`}>{STATUS_LABEL[level.status]}</span>
            {isForging(level.status) && <Stepper status={level.status} />}
            {elapsed !== null && <div className="dim">{fmt(elapsed)}</div>}
          </>
        ) : playable ? (
          <span className={isNext ? "cta" : "cta quiet"}>
            {/* "Replay" only makes sense for a floor you have actually beaten;
                a floor `?dev` unlocked ahead of you has never been climbed. */}
            {level.index > maxCleared ? "Climb ▶" : isNext ? "Climb again ▶" : "Replay"}
          </span>
        ) : level.index === next + 1 ? (
          <span className="dim">clear floor {level.index - 1} first</span>
        ) : null}
      </div>
    </button>
  );
}

function describe(level: LevelRecord, isFrontier: boolean, above: LevelRecord | null): string {
  const n = level.index;
  switch (level.status) {
    case "awaiting":
      return `${level.forgedBy ?? "Someone"} cleared floor ${n - 1} first and is writing this floor`;
    case "forging:composing":
    case "forging:world":
    case "forging:creatures":
      return level.forgedBy ? `Written by ${level.forgedBy} · being forged` : "Forged from the room's votes";
    case "sealed":
      return `Forged and sealed — opens when floor ${n - 1} falls`;
    case "failed":
      return "The forge failed — the next clear retries it";
    case "ready":
      break;
  }
  if (isFrontier) {
    return above?.forgedBy
      ? `${above.forgedBy} cleared this first. Clear it too and your name joins floor ${n + 1}'s plaque.`
      : `Nobody has cleared this. First to do it writes floor ${n + 1}.`;
  }
  if (level.forgedBy) {
    return `Forged by ${level.forgedBy}${level.coForgers.length ? ` · with ${level.coForgers.join(", ")}` : ""}`;
  }
  return "Foundation";
}

const STAGES: Array<[LevelStatus, string]> = [
  ["forging:composing", "composing"],
  ["forging:world", "world"],
  ["forging:creatures", "creatures"],
];

function Stepper({ status }: { status: LevelStatus }) {
  const at = STAGES.findIndex(([s]) => s === status);
  return (
    <div className="stepper">
      {STAGES.map(([, label], i) => (
        <span key={label} className={i < at ? "done" : i === at ? "live" : ""}>
          {i < at ? `${label} ✓` : label}
        </span>
      ))}
    </div>
  );
}

function GhostRung({ floor, below }: { floor: number; below: number }) {
  return (
    <div className="rung ghost">
      <div className="idx">{pad(floor)}</div>
      <div>
        <div className="theme">Not yet written</div>
        <div className="meta">
          Whoever clears floor {below} first writes this floor — and leaves a message on it.
        </div>
      </div>
      <div className="state">
          <span className="stamp dim">proposed</span>
        </div>
    </div>
  );
}

function NameTag({ user, onRename }: { user: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user);

  const commit = () => {
    const name = draft.trim();
    if (name && name !== user) onRename(name);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="name-input"
        autoFocus
        maxLength={24}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <span>
      you are <span className="name">{user}</span>
      <button
        className="name-edit"
        title="Change your name — it goes on your monument"
        onClick={() => {
          setDraft(user);
          setEditing(true);
        }}
      >
        ✎
      </button>
    </span>
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Stamps are the system's voice: failure is red, everything else is cyan. */
function stampTone(status: LevelStatus): string {
  return status === "failed" ? "red" : status === "sealed" ? "dim" : "";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function fmt(seconds: number): string {
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`;
}
