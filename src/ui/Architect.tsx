import { useEffect, useRef, useState } from "react";
import type { ThemeTag } from "../game/balance";
import { MAX_MESSAGE, MAX_PROMPT, leaning, pickPrefill } from "../prefills";

interface Props {
  /** The floor being written — one above the one just cleared. */
  floor: number;
  /** Votes cast on the floor below; they tilt the suggestions. */
  tally: Partial<Record<ThemeTag, number>>;
  /** When the tower forges without you. Null disables the clock. */
  deadline: number | null;
  now: number;
  forged: boolean;
  onForge: (prompt: string, message: string) => void;
}

/**
 * The architect's desk: shown once, to the first player who clears the
 * frontier. Pre-filled so "just hit Forge" is a complete answer, free-text so
 * anyone with an idea can use it.
 */
export function Architect({ floor, tally, deadline, now, forged, onForge }: Props) {
  const [prompt, setPrompt] = useState(() => pickPrefill(tally));
  const [message, setMessage] = useState("");
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const leaned = leaning(tally).slice(0, 2);

  const submit = () => {
    const text = prompt.trim() || pickPrefill(tally);
    onForge(text.slice(0, MAX_PROMPT), message.trim().slice(0, MAX_MESSAGE));
  };

  // When the clock runs out, send whatever is in the box: the suggestion the
  // architect was looking at beats a floor forged from nothing.
  const latest = useRef(submit);
  latest.current = submit;
  const fired = useRef(false);
  useEffect(() => {
    if (forged || remaining !== 0 || fired.current) return;
    fired.current = true;
    latest.current();
  }, [remaining, forged]);

  if (forged) {
    return (
      <div className="architect done">
        <div className="label">Forging floor {floor}</div>
        <p>
          It takes a few minutes. Watch it rise on the tower — when it opens, everyone climbs it
          {message.trim() ? " and reads your message on the way in" : ""}.
        </p>
      </div>
    );
  }

  return (
    <div className="architect">
      <div className="field">
        <div className="label-row">
          <label htmlFor="architect-prompt">What is floor {floor}?</label>
          <button
            type="button"
            className="refresh"
            title="Another suggestion"
            onClick={() => setPrompt(pickPrefill(tally, prompt))}
          >
            ↻ suggest another
          </button>
        </div>
        <textarea
          id="architect-prompt"
          rows={3}
          maxLength={MAX_PROMPT}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
        />
        <div className="hint">
          {leaned.length > 0 ? (
            <>
              The room leaned{" "}
              {leaned.map(([tag, n], i) => (
                <span key={tag}>
                  {i > 0 && " · "}
                  <b>{tag}</b> {n}
                </span>
              ))}
              . Suggestions lean too — but write anything.
            </>
          ) : (
            "Describe a place: materials, light, scale. Keep a wide floor to fight on."
          )}
        </div>
      </div>

      <div className="field">
        <div className="label-row">
          <label htmlFor="architect-message">
            Leave a message on the floor <em>optional</em>
          </label>
          <span className="count">
            {message.length}/{MAX_MESSAGE}
          </span>
        </div>
        <input
          id="architect-message"
          maxLength={MAX_MESSAGE}
          placeholder={`Everyone who reaches floor ${floor} walks over it.`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <div className="row">
        <button className="primary" onClick={submit}>
          Forge floor {floor}
        </button>
        {remaining !== null && (
          <span className="deadline">
            auto-forges in {Math.floor(remaining / 60)}:{(remaining % 60).toString().padStart(2, "0")}
          </span>
        )}
      </div>
    </div>
  );
}
