const KEY = "babel.player";

const ADJECTIVES = ["Ashen", "Iron", "Pale", "Swift", "Hollow", "Bright", "Grim", "Verdant"];
const NOUNS = ["Climber", "Wanderer", "Sentinel", "Vagrant", "Herald", "Pilgrim", "Scout"];

export function playerName(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    // Private windows and blocked storage: fall through to an ephemeral name.
  }
  const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
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
