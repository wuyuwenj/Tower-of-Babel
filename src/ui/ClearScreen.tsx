import { useState } from "react";
import type { ThemeTag } from "../game/balance";
import type { RunRow } from "../useLadder";
import { Architect } from "./Architect";

interface Props {
  cleared: boolean;
  /** First to clear it: the monument on the floor above is theirs. */
  first: boolean;
  /** The floor above is theirs to write. */
  canWrite: boolean;
  runs: RunRow[];
  user: string;
  levelIndex: number;
  score: number;
  timeSeconds: number;
  message: string | null;
  tally: Partial<Record<ThemeTag, number>>;
  deadline: number | null;
  now: number;
  onForge: (prompt: string, message: string) => void;
  onRetry: () => void;
  onLadder: () => void;
}

export function ClearScreen(props: Props) {
  const [forged, setForged] = useState(false);
  const mins = Math.floor(props.timeSeconds / 60);
  const secs = Math.floor(props.timeSeconds % 60);
  const time = `${mins}:${secs.toString().padStart(2, "0")}`;
  const architect = props.cleared && props.canWrite;
  // The desk comes first; scores can wait until the floor is written.
  const showRuns = props.runs.length > 0 && (!architect || forged);

  const forge = (prompt: string, message: string) => {
    setForged(true);
    props.onForge(prompt, message);
  };

  return (
    <div className="overlay">
      <div className="panel" style={{ maxWidth: architect ? 680 : 560 }}>
        <h1>
          {!props.cleared
            ? "You fell"
            : props.first
              ? `Floor ${props.levelIndex} cleared — you were first.`
              : `Floor ${props.levelIndex} cleared`}
        </h1>
        <p className="sub">
          {architect && <>Floor {props.levelIndex + 1} is yours to build. </>}
          Score {props.score} · {time}
        </p>

        {architect && (
          <Architect
            floor={props.levelIndex + 1}
            tally={props.tally}
            deadline={props.deadline}
            now={props.now}
            forged={forged}
            onForge={forge}
          />
        )}

        {!architect && props.message && (
          <p style={{ color: "var(--gold)", fontSize: 14, lineHeight: 1.6, marginTop: -8 }}>
            {props.message}
          </p>
        )}

        {showRuns && (
          <div style={{ marginTop: architect ? 0 : 20, marginBottom: architect ? 18 : 0 }}>
            <div className="bar-label" style={{ marginBottom: 8 }}>
              <span>BEST ON THIS FLOOR</span>
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

        <div className="row" style={{ marginTop: architect ? 4 : 24 }}>
          {(!architect || forged) && (
            <button className="primary" onClick={props.onRetry}>
              {props.cleared ? "Climb again" : "Retry floor"}
            </button>
          )}
          <button className="ghost" onClick={props.onLadder}>
            Back to the tower
          </button>
        </div>
      </div>
    </div>
  );
}
