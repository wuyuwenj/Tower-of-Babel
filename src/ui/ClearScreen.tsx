import type { RunRow } from "../useLadder";

interface Props {
  cleared: boolean;
  runs: RunRow[];
  user: string;
  levelIndex: number;
  score: number;
  timeSeconds: number;
  message: string | null;
  onRetry: () => void;
  onLadder: () => void;
}

export function ClearScreen(props: Props) {
  const mins = Math.floor(props.timeSeconds / 60);
  const secs = Math.floor(props.timeSeconds % 60);
  return (
    <div className="overlay">
      <div className="panel" style={{ maxWidth: 560 }}>
        <h1>{props.cleared ? `Level ${props.levelIndex} cleared` : "You fell"}</h1>
        <p className="sub">
          Score {props.score} · {mins}:{secs.toString().padStart(2, "0")}
        </p>
        {props.message && (
          <p style={{ color: "var(--gold)", fontSize: 14, lineHeight: 1.6, marginTop: -8 }}>
            {props.message}
          </p>
        )}
        {props.runs.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="bar-label" style={{ marginBottom: 8 }}>
              <span>BEST ON THIS RUNG</span>
            </div>
            {props.runs.slice(0, 5).map((run, i) => (
              <div
                key={`${run.user}-${i}`}
                className="row"
                style={{
                  fontSize: 13,
                  padding: "5px 0",
                  color: run.user === props.user ? "var(--gold)" : "var(--muted)",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <span style={{ width: 22, opacity: 0.6 }}>{i + 1}</span>
                <span>{run.user}</span>
                <div className="spacer" />
                <span>{run.score}</span>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 24 }}>
          <button className="primary" onClick={props.onRetry}>
            {props.cleared ? "Climb again" : "Retry level"}
          </button>
          <button className="ghost" onClick={props.onLadder}>
            Back to the tower
          </button>
        </div>
      </div>
    </div>
  );
}
