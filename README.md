# Lock In

A Windows desktop app that plays your music while you're in menus or dead, and
pauses it the moment you're back in a live round — for Valorant, League of
Legends and Marvel Rivals.

## What it does

- Watches which game is running and works out the live game state: menu, buy
  phase, live round, round over, and whether you are alive or dead.
- Plays or pauses Spotify, YouTube in a browser, or any other Windows media
  player to match, without touching your volume.
- Reads death from the game itself: Riot's local API for League, and the
  on-screen "KILLED BY" banner (via Windows OCR) for Valorant and Marvel Rivals.
- Hype mode: in Valorant, detects a 1v1 clutch from the HUD's alive counters
  and starts a hype track.
- Shows an optional "you died, do 5 pushups" reminder card and keeps a tally of
  who killed you most.

## Tech stack

- **Electron 33** (Node.js main process, plain HTML/CSS/JS renderer, no
  framework) packaged with **electron-builder** (NSIS installer, portable .exe, zip)
- **Windows Runtime APIs reached through PowerShell**: Global System Media
  Transport Controls for play/pause, `Windows.Media.Ocr` for text recognition
- **Riot Live Client Data API** (local HTTPS endpoint) for League of Legends
- Electron `desktopCapturer` / `getDisplayMedia` for screen capture, and a
  hand-written connected-component pass for reading HUD digits
- No runtime npm dependencies — only Electron and electron-builder as dev
  dependencies

## How it works

1. **Game detection.** Every 3 seconds the app runs `tasklist` and checks for
   each game's process names. The first running game becomes "active"; with no
   game running, the app leaves your music completely alone.
2. **Per-game adapters** turn whatever that game exposes into one shared state:
   a phase (`off` / `menu` / `prep` / `live` / `end`) plus `alive` (true, false
   or unknown).
   - **League** — polls Riot's official Live Client Data API at
     `https://127.0.0.1:2999` once a second; it reports `isDead` directly. The
     endpoint only exists during a match, so "client open but port closed" means
     you're in the lobby. Its self-signed certificate is trusted only for that
     loopback host, in its own Electron session.
   - **Valorant** — tails `%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log`
     and parses round markers (buy phase, barriers dropping, round end). Death
     isn't logged, so it comes from OCR of the "KILLED BY" banner.
   - **Marvel Rivals** — its logs are encrypted and there's no local API, so it
     relies only on OCR of the death text you configure.
3. **Screen reading.** A hidden Electron window keeps a 10 fps capture stream of
   the primary display, but only while something needs it (a live round). Crops
   are sent to a single long-lived PowerShell process running Windows' built-in
   OCR engine (about 10 ms per read, no bundled model). Matching tolerates common
   OCR mix-ups like `1`/`l`/`I` and `0`/`O`.
4. **Controller.** A small decision function maps (game, phase, alive) plus your
   per-game settings to "play", "pause" or "no opinion", debounces it, and only
   sends a command when the decision actually changes.
5. **Playback.** Play/pause goes through Windows' Global System Media Transport
   Controls — the same layer as the media flyout by the volume slider — so it
   works with the Spotify desktop app, browsers and most players, with no
   account, API key or Premium subscription.

## Quick start

Requirements: Windows 10 or 11, [Node.js](https://nodejs.org/) 18 or newer, and
a music player that shows up in the Windows media flyout (for example the
Spotify desktop app or YouTube in a browser).

```bash
git clone https://github.com/OceanAKA/LockIn.git
cd LockIn
npm install
npm start
```

Start something playing in your player once so Windows registers it, then
launch a supported game. To build a Windows installer, portable .exe and zip
into `dist/`:

```bash
npm run dist
```

No Spotify developer app, client ID or login is needed: the app does not use the
Spotify Web API. It controls whatever player Windows already knows about.

## How I built it

Built with Claude Code (Anthropic's AI coding agent): I designed the product,
directed the implementation, and tested and iterated on it in real Valorant
matches — for example, verifying the Valorant log parsing against a full
61-round match. League of Legends and Marvel Rivals support is implemented but
not yet tested in live matches.

## Disclaimer

Lock In is an independent hobby project. It is not affiliated with, endorsed by,
or sponsored by Riot Games, NetEase Games, Marvel or Spotify. All game and
product names are trademarks of their respective owners.

Licensed under the [MIT License](LICENSE).

---

# Technical details

## How each game is detected

The three games expose wildly different amounts of information. Lock In uses
the best source each one offers, and the app tells you which it's using.

| Game | Source | Quality |
|---|---|---|
| **League of Legends** | Riot's Live Client Data API (`127.0.0.1:2999`) | **Exact.** Alive/dead comes straight from the API. No calibration. |
| **Valorant** | `ShooterGame.log` + OCR of the death banner | **Exact.** Rounds from the log, death from the `KILLED BY` text. No calibration. |
| **Marvel Rivals** | Screen only | **Needs setup.** NetEase encrypts the logs; you supply the death wording. |

Only one game is watched at a time — whichever is running. When nothing is
running, Lock In leaves your music completely alone.

### League of Legends — the easy one

Riot ships an official, documented, unauthenticated API on `127.0.0.1:2999`
while a game is in progress. It reports every player's `isDead` and
`respawnTimer` directly, so nothing has to be inferred and nothing needs
calibrating. The endpoint only exists during a live game, so its reachability
doubles as the in-game test: client running but port closed means you're in
lobby, queue, or champ select.

It serves a self-signed certificate. Lock In gives that one loopback origin
its own Electron session that trusts it, so everything else keeps full
certificate verification.

### Valorant — exact rounds, OCR for death

`%LOCALAPPDATA%\VALORANT\Saved\Logs\ShooterGame.log` gives the round cycle
precisely. The key line is `Gameplay started at local time`:

| Line | Means |
|---|---|
| `Broadcasting state changed to MainMenu` / `Pregame` | menus, agent select |
| `Gameplay started at local time 0.03` | buy phase opened |
| `Gameplay started at local time 30.00` (or `45` on a half's first round) | **barriers dropped — round is live** |
| `OnRoundEnded for round 'N'` | round over |

Verified against a real 61-round match: a clean `buy -> live -> roundend` cycle
for every round.

**Death is not in the log.** Every candidate was checked and ruled out:
`_PostDeath_` pawns only appear for Clove, input bindings are noise, no death
buff lands on your own pawn, and `AcknowledgePossession` fires once per round as
a respawn marker.

So death is detected by reading the **KILLED BY** banner on the combat report
instead — see below. That text is either on screen or it isn't, which makes it a
hard signal with nothing to calibrate.

### Marvel Rivals — screen only

The logs at `%LOCALAPPDATA%\Marvel\Saved\Logs\` start with a `logversion000`
header followed by encrypted binary, and there is no local API. The only handle
is the text the game shows when you die, which you type into its **Death text**
box. Until you do, Lock In only knows the game is open, so music simply plays
the whole time.

---

## Death detection: the KILLED BY banner

When you die, Valorant's combat report shows **KILLED BY SAGE**. Lock In looks for
that text using the OCR engine built into Windows — nothing to install, no bundled
model — and treats finding it as proof you died.

This is a hard check, not a guess: the text is present or it isn't. It replaced
an earlier pixel-sampling approach that needed per-user calibration, and it
doubles as a tally of your nemeses.

By default it scans the **right side of the screen**, where the report sits.
Switch to **Whole screen** if it ever misses. One PowerShell OCR worker stays
resident; each read takes about 10ms and runs roughly once a second, only during
a live round.

The wording is per game, under **Games → Death text** — Valorant ships with
`KILLED BY`. Any game that prints something on death can be supported by typing
what it says. Matching tolerates the ways OCR mangles text (`1`/`l`/`I`, `0`/`O`,
`5`/`S`, `8`/`B`, and missing spaces), so `k1lled 8y` still matches.

**Valorant never infers "alive" from the banner being gone** — you can hide the
report with `[N]`, so its absence proves nothing and death is only ever asserted
from positive evidence. Screen-only games have no such key and no log to fall
back on, so there the banner clearing is what tells Lock In you respawned.

It captures two things:

- **The agent**, straight off the banner. Reliable.
- **The player name**, from the row underneath where the agent is repeated with
  the display name pushed to the right (`Sage        Aura`). Best effort: it only
  accepts that name when the row really looks like that two-column layout, so a
  bad read yields nothing rather than a wrong name. The agent always works.

**Test read now** OCRs the screen immediately and shows what it found, so you can
check it works without waiting to die.

## Music

Playback runs through Windows' Global System Media Transport Controls — the same
layer behind your volume flyout. That covers **YouTube in any browser, YouTube
Music, the Spotify desktop app**, and most other players, with no account, no
Premium and no app registration. Windows Runtime has no Electron binding, so
each command is a short PowerShell script that calls the WinRT API and returns
JSON.

Pick which player to control, or leave it on **Automatic**, which acts on
whichever session is actually playing. Hit **Rescan players** after starting
something new.

It only ever calls play and pause — your volume is never touched. There's no
playlist targeting: it resumes whatever the player already has loaded, so queue
something up first.

## Hype mode

Turn it on under **Hype**, paste your hype music, and when a round comes down to
**you against one of them** the music drops — the only time Lock In plays music
while you're alive. It stops when the round ends.

### The music

Paste any of:

- A **Spotify** link or URI (right-click a track or playlist → Share → Copy
  link). Lock In hands it straight to the Spotify app, which starts it.
- A **YouTube** URL. Opens in your browser and autoplays.
- A **folder of tracks** (for example `D:\Music\Hype`). Lock In plays them
  itself, shuffled, and your regular player stays paused so nothing fights.

### How it knows it's a 1v1

Valorant prints the alive count for each team in two small boxes beside the
round timer: `3  0:34  3`. Lock In reads those digits off the screen.

Windows OCR won't return a lone digit, so the read is geometric: threshold the
box to its white pixels, take the connected blob nearest the centre (ignoring the
HUD's border lines), and test its shape. A **1** is a thin solid bar — much
narrower than it is tall, and it fills most of its own bounding box. Every other
digit is wider, and the near miss (a 7) is hollow. Both tests must agree.

Measured on real captures: a 3, 4 and 7 read at aspect 0.54–0.67 and fill
0.30–0.40; the cut for a 1 is aspect < 0.5 **and** fill > 0.45. About 20ms a
poll, only while a round is live and you're alive.

**Scan HUD now** grabs both boxes and outlines what it found — green for a 1,
amber for anything else — so you can confirm it's looking in the right place.
The box positions were measured on a 16:9 screen; if yours differ, nudge
**Distance from centre** and **Top edge**.

Note: in Team Deathmatch those boxes show kill score, not alive count. Hype mode
is meant for round-based modes, where a 1v1 is a real thing.

## The death reminder

Every time you die, a card appears at the top of the screen — **Do 5 pushups** by
default, with a running tally of what you owe. Edit the message to whatever you
like; the number in it drives the tally.

It fires only on a real alive → dead transition during a live round. Starting the
app mid-round while already dead, spectating, or a game switch won't trigger it,
and staying dead won't re-fire.

**If your game runs in exclusive fullscreen, the card can't appear.** Windows
won't draw any window over an exclusive-fullscreen game — that's a platform
rule, not a limitation of this app. Two options:

- Set the game to **borderless** or **windowed fullscreen** (Valorant: Settings →
  Video → Display Mode). Costs nothing in performance on modern Windows.
- Or turn on **Say it out loud**, which speaks the reminder through Windows TTS
  and works regardless of display mode.

Use **Preview it** to see the card without dying first.

The card is a normal always-on-top desktop window — the same kind Discord and
Steam use — not an injected game overlay. It never takes focus and clicks pass
straight through, so it can't tab you out or eat a shot.

## The window

Lock In lives as a **small box in the bottom-right corner** with one big ON/OFF
button and a line of status — which game it sees, and whether music is playing.
The gear icon expands it to the full settings pane; clicking it again shrinks it
back.

Switching it **OFF** makes the app completely hands-off: it stops touching
playback, stops the OCR poller and stops screen capture. Nothing runs until you
turn it back on.

The three title-bar buttons do what they look like:

| | |
|---|---|
| **&ndash;** | Minimises to the taskbar, like any window. Click it in the taskbar to bring it back. |
| **&#9881;** | Expands to full settings, or shrinks back to the widget. |
| **&times;** | Quits. |

**Hide to tray** (in settings, or the tray menu) is the separate thing: the
window vanishes completely and only the tray icon remains. It keeps running
either way — minimised or hidden, it's still watching your game.

By default the widget behaves like a normal window and sits behind whatever you
switch to. If you'd rather it float above everything, tick **Keep on top of
other windows** in settings or the tray menu.

The tray icon's right-click menu has **Show**, **Hide to tray**, **Keep on top**,
**Start with Windows**, and **Quit**. **Start with Windows** launches it straight
to the tray at login, so it's just always there.

Only one copy can run at a time — launching it again focuses the existing window
rather than starting a second one that would fight over playback.

## Settings

Settings are grouped into five tabs:

| Tab | Holds |
|---|---|
| **Music** | Which player to control, and a playback test |
| **Death** | Banner detection, where to scan, a live test read, and your nemesis tally |
| **Hype** | 1v1 clutch music: source, on/off, and a live view of the alive-count scanner |
| **Games** | Per-game music rules and the death wording |
| **App** | The reminder, window behaviour, and startup |

Config lives in `%APPDATA%\Lock In\config.json`.

The app used to be called ValoTunes, back when it only handled Valorant. On
first run it carries the old `%APPDATA%\valotunes` profile across, including
Chromium's `Local State`, which is where encrypted settings are keyed from.
The old folder is left untouched and can be deleted once you're happy.

## Installing a build

`npm run dist` writes `Lock In Setup 1.0.0.exe` (plus a portable .exe and a zip)
to `dist/`. The installer installs for the current user only (no admin prompt)
and puts **Lock In** on your Desktop and in the Start menu. Uninstall from
Settings → Apps like any other program; your config is kept.

---

## Troubleshooting

**"No player found"** — nothing has registered a media session yet. Start a
YouTube video or a track, then hit **Rescan players**.

**League shows menus during a game** — the Live Client Data API takes a few
seconds to come up after the loading screen. It self-corrects.

**Phase stuck on `not running`** — detection is by process name
(`VALORANT-Win64-Shipping.exe`, `League of Legends.exe`,
`Marvel-Win64-Shipping.exe`) and rescans every 3 seconds.

**Death not detected** — use **Test read now** on the Death tab while the banner
is on screen. If it misses, switch the scan area to **Whole screen**, and make
sure the game is on the primary display.

**Multi-monitor** — capture targets the primary display. Put the game there.

**`npm run dist` finishes but produces no installer** — electron-builder's signing
toolchain contains macOS symlinks, and Windows refuses to create those without
Developer Mode, so extraction fails and it silently stops after `win-unpacked`.
Look for `Cannot create symbolic link` in the output. Pre-extract the cache
without the macOS folder, once:

```bash
node_modules/7zip-bin/win/x64/7za.exe x -o"$LOCALAPPDATA/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" "$LOCALAPPDATA/electron-builder/Cache/winCodeSign/"*.7z '-xr!darwin' -y
```

**The installer crashes when launched from Git Bash** — NSIS installers don't
survive the MSYS process layer. Run it from PowerShell or just double-click it.

**"Electron failed to install correctly"** — `npm install` reports success but
`extract-zip` silently unpacks only `LICENSES.chromium.html`. The download itself
is fine and cached, so extract it yourself (adjust the version to match the one
in your cache):

```powershell
Expand-Archive -Path "$env:LOCALAPPDATA\electron\Cache\*\electron-v33.4.11-win32-x64.zip" -DestinationPath ".\node_modules\electron\dist" -Force; Set-Content .\node_modules\electron\path.txt "electron.exe" -NoNewline
```

---

## Anti-cheat and fair play

Lock In only uses passive, read-only sources: a log file the game already
writes, Riot's official local API, and capture of your own screen — the same
kinds of things OBS and match trackers do. It does not read game memory, inject
code, draw inside the game, or automate any input, and it gives no competitive
advantage. That said, it is not reviewed or approved by any game publisher, so
use it at your own discretion.
