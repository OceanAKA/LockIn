'use strict';

/**
 * Static description of every supported game: how its state is discovered, what
 * screen states (if any) the user has to calibrate, and what its settings mean.
 *
 * `source` is the honest capability level:
 *   'log'    — the game writes a readable log we can tail (exact, free)
 *   'api'    — the game exposes a local API (exact, free)
 *   'screen' — nothing readable exists; everything comes from calibration
 */

// Where the death banner lives. Valorant's combat report sits right of centre.
const RIGHT_SIDE = { x: 0.35, y: 0, w: 0.65, h: 1 };

const GAMES = {
  valorant: {
    id: 'valorant',
    name: 'Valorant',
    source: 'log',
    processes: ['VALORANT-Win64-Shipping.exe'],
    clientProcesses: ['VALORANT.exe', 'RiotClientServices.exe'],
    // Round state is exact from the log; death comes from on-screen text.
    deathText: true,
    hasPrep: true,
    prepLabel: 'Buy phase & between rounds',
    defaults: {
      enabled: true,
      playInMenus: true,
      playInPrep: true,
      playWhenDead: true,
      deathPhrase: 'KILLED BY'
    }
  },

  league: {
    id: 'league',
    name: 'League of Legends',
    source: 'api',
    processes: ['League of Legends.exe'],
    clientProcesses: ['LeagueClient.exe', 'LeagueClientUx.exe'],
    // Riot's Live Client Data API reports isDead directly — no screen reading.
    deathText: false,
    hasPrep: false,
    prepLabel: null,
    defaults: {
      enabled: true,
      playInMenus: true,
      playInPrep: false,
      playWhenDead: true,
      deathPhrase: ''
    }
  },

  marvelrivals: {
    id: 'marvelrivals',
    name: 'Marvel Rivals',
    source: 'screen',
    processes: ['Marvel-Win64-Shipping.exe'],
    clientProcesses: [],
    // NetEase encrypts the logs, so on-screen text is the only handle.
    deathText: true,
    hasPrep: false,
    prepLabel: null,
    defaults: {
      enabled: true,
      playInMenus: true,
      playInPrep: false,
      playWhenDead: true,
      deathPhrase: ''
    }
  }
};

const GAME_IDS = Object.keys(GAMES);

/** Fresh copy of a game's defaults, so callers can't mutate the shared object. */
function gameDefaults(id) {
  return { ...GAMES[id].defaults };
}

module.exports = { GAMES, GAME_IDS, gameDefaults, RIGHT_SIDE };
