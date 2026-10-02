# Lock In

Auto-plays your music while you're in **menus** or **dead**, and shuts it off when
you're alive in a live round. Supports **Valorant**, **League of Legends**, and
**Marvel Rivals**.

Windows only. No Spotify account needed.

---

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

### Valorant — exact rounds, calibrated death

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
header followed by encrypted binary. There is no local API. Everything therefore
the only handle is the text the game shows when you die, which you type into
its **Death text** box. Until you do, Lock In only knows the game is open, so
music simply plays the whole time.

---

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

## Install

Run `Lock In Setup 1.0.0.exe` from `dist/`. It installs for your user only (no
admin prompt), and puts **Lock In** on your Desktop and in the Start menu.
Uninstall from Settings → Apps like any other program; your config is kept.

Once installed you never need a terminal — double-click the shortcut.

The tray icon's right-click menu has **Show**, **Hide to tray**, **Keep on top**,
**Start with Windows**, and **Quit**. **Start with Windows** launches it straight
to the tray at login, so it's just always there.

Only one copy can run at a time — launching it again focuses the existing window
rather than starting a second one that would fight over playback.

### Running from source instead

```bash
npm install
```

```bash
npm start
```

To rebuild the installer after changing code:

```bash
npm run dist
```

## Music

Playback runs through Windows' Global System Media Transport Controls — the same
layer behind your volume flyout. That covers **YouTube in any browser, YouTube
Music, the Spotify desktop app**, and most other players, with no account, no
Premium and no app registration.

Pick which player to control, or leave it on **Automatic**, which acts on
whichever session is actually playing. Hit **Rescan players** after starting
something new.

It only ever calls play and pause — your volume is never touched. There's no
playlist targeting: it resumes whatever the player already has loaded, so queue
something up first.

### No calibration

Earlier versions learned alive-from-dead by sampling screen pixels. That's gone.
Death is now read as text, which is exact and needs no training.

---

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
Steam use — not an injected game overlay, so anti-cheat has no issue with it. It
never takes focus and clicks pass straight through, so it can't tab you out or
eat a shot. It sits at the top of the screen, clear of the bottom HUD strip the
screen classifier reads, so it can't confuse death detection.

## Hype mode

Turn it on under **Hype**, paste your hype music, and when a round comes down to
**you against one of them** the music drops — the only time Lock In plays music
while you're alive. It stops when the round ends.

### The music

Paste any of:

- A **Spotify** link or URI (right-click a Kryd track or playlist → Share → Copy
  link). Lock In hands it straight to the Spotify app, which starts it.
- A **YouTube** URL. Opens in your browser and autoplays.
- A **folder of tracks** (`C:\Music\Kryd`). Lock In plays them itself, shuffled,
  and your regular player stays paused so nothing fights.

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

## Death detection: the KILLED BY banner

When you die, Valorant's combat report shows **KILLED BY SAGE**. Lock In looks for
that text using the OCR engine built into Windows — nothing to install, no bundled
model — and treats finding it as proof you died.

This is a hard check, not a guess: the text is present or it isn't. It replaces
the pixel calibration entirely, and it doubles as a tally of your nemeses.

By default it scans the **right side of the screen**, where the report sits.
Switch to **Whole screen** if it ever misses. Each read costs about 10ms and runs
roughly once a second, only during a live round.

The wording is per game, under **Games → Death text** — Valorant ships with
`KILLED BY`. Any game that prints something on death can be supported by typing
what it says. Matching tolerates the ways OCR mangles text (`1`/`l`/`I`, `0`/`O`,
`5`/`S`, `8`/`B`, and missing spaces), so `k1lled 8y` still matches.

**Valorant never infers "alive" from the banner being gone** — you can hide the
report with `[N]`. Screen-only games have no such key and no log to fall back on,
so there the banner clearing is what tells Lock In you respawned.

It captures two things:

- **The agent**, straight off the banner. Reliable.
- **The player name**, from the row underneath where the agent is repeated with
  the display name pushed to the right (`Sage        Aura`). Best effort: it only
  accepts that name when the row really looks like that two-column layout, so a
  bad read yields nothing rather than a wrong name. The agent always works.

Because the banner only appears when you're dead, seeing it *is* proof of death.
Turn on **Use it as the death signal** and Valorant needs no screen calibration
at all — this replaces the alive/dead sample capture entirely.

Absence of the banner never implies you're alive (you can hide the report with
`[N]`), so it only ever asserts death. That keeps a hidden report from being
mistaken for a respawn.

**Test read now** OCRs the screen immediately and shows what it found, so you can
check it works without waiting to die.

Cost: one PowerShell worker stays resident and each read takes about 10ms, polled
roughly once a second and only during a live round.

## Settings

Settings are grouped into four tabs:

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

---

## Troubleshooting

**"No player found"** — nothing has registered a media session yet. Start a
YouTube video or a track, then hit **Rescan players**.

**League shows menus during a game** — the Live Client Data API takes a few
seconds to come up after the loading screen. It self-corrects.

**Phase stuck on `not running`** — detection is by process name
(`VALORANT-Win64-Shipping.exe`, `League of Legends.exe`,
`Marvel-Win64-Shipping.exe`) and rescans every 3 seconds.

**Death detection jumpy** — reset and recapture with more varied alive samples.

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
is fine and cached, so extract it yourself:

```powershell
Expand-Archive -Path "$env:LOCALAPPDATA\electron\Cache\*\electron-v33.4.11-win32-x64.zip" -DestinationPath ".\node_modules\electron\dist" -Force; Set-Content .\node_modules\electron\path.txt "electron.exe" -NoNewline
```

---

## Is this bannable?

No. It reads a log file the game already writes, queries an official Riot API,
and captures your own screen — the same things OBS and every match tracker do. It
does not read game memory, inject code, draw an overlay, or automate input. It
gives no competitive advantage.

## Building a standalone .exe

```bash
npm run dist
```
