import type { CardOffer } from "./cards";
import type { ThemeTag } from "./balance";

export interface GameEvents {
  hp: { hp: number; maxHp: number };
  xp: { xp: number; needed: number; level: number };
  wave: { wave: number; wavesPerLevel: number; remaining: number };
  levelup: { offers: CardOffer[] };
  boss: { hp: number; maxHp: number } | null;
  clear: { levelIndex: number; score: number; timeSeconds: number };
  death: { levelIndex: number; score: number; timeSeconds: number };
  pick: { tag: ThemeTag };
  loading: { stage: string; done: boolean };
  fps: { value: number };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(key as string);
    if (!set) {
      set = new Set();
      this.handlers.set(key as string, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(key: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(key as string);
    if (!set) return;
    for (const fn of set) (fn as Handler<K>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
