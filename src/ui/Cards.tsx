import type { CardOffer } from "../game";

export function Cards({ offers, onPick }: { offers: CardOffer[]; onPick: (o: CardOffer) => void }) {
  return (
    <div className="overlay">
      <div className="panel">
        <h1>Choose an upgrade</h1>
        <p className="sub">
          Your picks are tallied across everyone on this level — they decide what the next level
          becomes.
        </p>
        <div className="cards">
          {offers.map((offer, i) => (
            <button key={i} className="card" onClick={() => onPick(offer)}>
              <div
                className="glyph"
                style={{
                  background: `radial-gradient(circle at 30% 30%, #${offer.color
                    .toString(16)
                    .padStart(6, "0")}, rgba(0,0,0,0.35))`,
                }}
              />
              <div className="slot">{offer.slot}</div>
              <div className="name">{offer.name}</div>
              <div className="desc">{offer.description}</div>
              <div className="tier">
                TIER {offer.tier} · {offer.tag.toUpperCase()}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
