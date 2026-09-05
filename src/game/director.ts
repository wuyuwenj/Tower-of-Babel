import { DIRECTOR } from "./balance";

/**
 * Absorbs variance that generated geometry and wild builds introduce.
 * It only scales spawn *rate*, within a hard clamp, so it can never
 * change the difficulty curve authored in balance.ts.
 */
export class Director {
  multiplier = 1;
  private sinceCheck = 0;
  private sinceDamage = 0;
  private damageWindow = 0;

  reset(): void {
    this.multiplier = 1;
    this.sinceCheck = 0;
    this.sinceDamage = 0;
    this.damageWindow = 0;
  }

  noteDamage(amount: number): void {
    if (amount <= 0) return;
    this.damageWindow += amount;
    this.sinceDamage = 0;
  }

  update(dt: number, hpFraction: number): void {
    this.sinceCheck += dt;
    this.sinceDamage += dt;
    if (this.sinceCheck < DIRECTOR.intervalSeconds) return;
    this.sinceCheck = 0;

    if (hpFraction < DIRECTOR.panicHpFraction) {
      this.multiplier -= DIRECTOR.step;
    } else if (this.sinceDamage > DIRECTOR.boredSeconds || this.damageWindow === 0) {
      this.multiplier += DIRECTOR.step;
    } else if (this.damageWindow > 45) {
      this.multiplier -= DIRECTOR.step * 0.5;
    }

    this.multiplier = Math.min(DIRECTOR.max, Math.max(DIRECTOR.min, this.multiplier));
    this.damageWindow = 0;
  }
}
