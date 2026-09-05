interface Props {
  hp: number;
  maxHp: number;
  xp: number;
  xpNeeded: number;
  playerLevel: number;
  wave: number;
  wavesPerLevel: number;
  remaining: number;
  levelIndex: number;
  themeLabel: string;
  boss: { hp: number; maxHp: number } | null;
  fps: number;
  onQuit: () => void;
}

export function Hud(props: Props) {
  const hpPct = Math.max(0, (props.hp / props.maxHp) * 100);
  const xpPct = Math.max(0, Math.min(100, (props.xp / props.xpNeeded) * 100));

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="wave-chip">
          Level {props.levelIndex} · {props.themeLabel} · Wave {props.wave}/{props.wavesPerLevel}
        </div>
        {props.boss && (
          <>
            <div className="bar-label">
              <span>BOSS</span>
              <span>{Math.ceil(props.boss.hp)}</span>
            </div>
            <div className="bar boss">
              <i style={{ width: `${(props.boss.hp / props.boss.maxHp) * 100}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="hud-bottom">
        <div className="bar-label">
          <span>HP</span>
          <span>
            {Math.ceil(props.hp)} / {Math.round(props.maxHp)}
          </span>
        </div>
        <div className="bar hp">
          <i style={{ width: `${hpPct}%` }} />
        </div>
        <div className="bar-label" style={{ marginTop: 10 }}>
          <span>LV {props.playerLevel}</span>
          <span>{props.remaining} left</span>
        </div>
        <div className="bar xp">
          <i style={{ width: `${xpPct}%` }} />
        </div>
      </div>

      <div className="hud-right">
        <div>{props.fps} fps</div>
        <div style={{ marginTop: 8 }}>
          <button className="ghost" onClick={props.onQuit}>
            Reset
          </button>
        </div>
        <div style={{ marginTop: 8, opacity: 0.6 }}>WASD move · Q/E turn · ` floor</div>
      </div>
    </div>
  );
}
