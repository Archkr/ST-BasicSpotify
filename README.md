# SillyTavern Media Player

A media player extension for SillyTavern that displays and controls your currently playing music. Works with any MPRIS-compatible media player on Linux (Spotify, VLC, Firefox, Cider, etc.) without needing API keys.

## Features

- **Now Playing Display** - Shows track name, artist, and album art
- **Playback Controls** - Play/pause, next, previous, shuffle, repeat
- **Progress Bar** - Visual progress with click-to-seek functionality
- **Time Display** - Current position and total duration
- **Collapsible Sidebar** - Minimizes to a small pill when not in use
- **MPRIS Integration** - Works with any Linux media player
- **Optional Spotify API** - Direct Spotify control (requires API setup)

## Requirements

- SillyTavern with server plugins enabled
- Linux with `playerctl` installed
- Any active media player (Spotify, VLC, Firefox, etc.)

## Installation

### 1. Install the Extension

Download or clone this repository and place the `SillyTavern-Spotify` folder into:

```
SillyTavern/public/scripts/extensions/third-party/
```

### 2. Install the Server Plugin

Copy the `plugins/mpris` folder from this repository into your SillyTavern plugins directory:

```
SillyTavern/plugins/
```

Your folder structure should look like:
```
SillyTavern/plugins/mpris/index.mjs
```

### 3. Enable Server Plugins

Edit your SillyTavern `config.yaml` and set:

```yaml
enableServerPlugins: true
```

### 4. Install playerctl

Install playerctl using your package manager:

- **Arch Linux:** `sudo pacman -S playerctl`
- **Debian/Ubuntu:** `sudo apt install playerctl`
- **Fedora:** `sudo dnf install playerctl`

### 5. Restart SillyTavern

Restart SillyTavern to load the plugin, then refresh your browser.

## Usage

1. Start playing music in any media player (Spotify, VLC, etc.)
2. The player sidebar will appear on the left side of SillyTavern
3. Use the controls to play/pause, skip tracks, toggle shuffle/repeat
4. Click on the progress bar to seek to any position
5. Click the collapse button to minimize the player

### Shuffle and Repeat Indicators

- **Green color + dot** = Feature is enabled
- **Gray color** = Feature is disabled
- **"1" on repeat** = Repeat single track mode

## Configuration

Access settings via **Extensions > Media Player**:

| Setting | Description |
|---------|-------------|
| Use Local Control (MPRIS) | Enable local media control (recommended) |
| Enable Player Panel | Show/hide the floating sidebar |
| Spotify API Authentication | Optional: Direct Spotify API control |

## Spotify API Mode (Optional)

For direct Spotify control without a local player:

1. Create an app at the Spotify Developer Dashboard
2. Add `http://localhost:8000` as a redirect URI
3. Copy your Client ID to the extension settings
4. Click "Connect" and authorize

## Troubleshooting

### Player not showing up?

1. Verify `enableServerPlugins: true` in config.yaml
2. Check if playerctl is installed: `playerctl status`
3. Ensure a media player is running and playing
4. Check browser console for errors

### Controls not working?

1. Restart SillyTavern after installing the plugin
2. Hard refresh the browser (Ctrl+Shift+R)
3. Try `playerctl play-pause` in terminal to test

### Album art not loading?

Album art requires the media player to provide artwork metadata. Some players may not support this feature.

## File Structure

This repository contains two components that go in different locations:

**Extension** (place in `SillyTavern/public/scripts/extensions/third-party/SillyTavern-Spotify/`):
```
├── index.js          # Main extension logic
├── settings.html     # Settings panel UI
├── style.css         # Styles for player and settings
├── manifest.json     # Extension metadata
└── README.md
```

**Server Plugin** (place in `SillyTavern/plugins/mpris/`):
```
└── index.mjs         # MPRIS controller using playerctl
```

## License

GNU License
