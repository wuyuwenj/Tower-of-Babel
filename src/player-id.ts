const KEY = "babel.player";

/**
 * Names are per-browser and never asked for: a sign-in screen in front of a
 * two-minute demo costs more than it is worth. The pool is large enough that
 * a room of players does not collide — a bare adjective/noun pair gave 56
 * combinations, so two strangers would routinely land on one name and merge
 * into a single row on the ladder. The trailing number makes even a repeated
 * pair distinct.
 */
const ADJECTIVES = [
  "Ashen", "Iron", "Pale", "Swift", "Hollow", "Bright", "Grim", "Verdant",
  "Gilded", "Quiet", "Amber", "Restless", "Sable", "Wayward", "Ember", "Stark",
];

const NOUNS = [
  "Climber", "Wanderer", "Sentinel", "Vagrant", "Herald", "Pilgrim", "Scout",
  "Bellringer", "Warden", "Mason", "Drifter", "Keeper", "Seeker", "Envoy",
];

export function playerName(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    // Private windows and blocked storage: fall through to an ephemeral name.
  }
  const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${10 + Math.floor(Math.random() * 90)}`;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // Ignore; the name just will not persist across reloads.
  }
  return name;
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(KEY, name.trim().slice(0, 24));
  } catch {
    // Ignore.
  }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
