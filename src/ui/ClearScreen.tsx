interface Props {
  cleared: boolean;
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
