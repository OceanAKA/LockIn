'use strict';

/**
 * Detects the alive -> dead transition of a live round.
 *
 * The subtlety is `alive === null`, which means "we don't know": screen
 * detection is off, the player is spectating, the API hasn't populated yet, or
 * the app just started. A null -> false step is *not* a death, and treating it
 * as one would fire the reminder every time the app launches mid-round or the
 * classifier briefly loses confidence.
 *
 * Only a genuine true -> false step while the phase is 'live' counts.
 */
class DeathEdge {
  constructor() { this.wasAlive = null; }

  reset() { this.wasAlive = null; }

  /**
   * @param {{phase: string, alive: boolean|null}} state
   * @returns {boolean} true exactly once per death
   */
  update({ phase, alive }) {
    if (phase !== 'live' || alive === null) {
      // Outside a live round, or with the player's state unknown, there's no
      // edge to stand on — start over rather than carry a stale value across.
      this.wasAlive = null;
      return false;
    }
    const died = this.wasAlive === true && alive === false;
    this.wasAlive = alive;
    return died;
  }
}

module.exports = { DeathEdge };
