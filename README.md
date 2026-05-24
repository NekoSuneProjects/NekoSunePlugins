# Pluxora Plugins

Production plugin packages for [Pluxora](https://github.com/search?q=pluxora&type=repositories). This repository is intended to be discoverable from the Pluxora dashboard and owner commands.

Add the `pluxora-package` GitHub topic to this repository so Pluxora can find it through GitHub Discovery.

## Plugins

| Plugin | Version | Status | Purpose |
| --- | ---: | --- | --- |
| `music-rainlink` | `1.1.1` | Production music plugin | Lavalink v3/v4 music playback through Rainlink, with embeds, controls, filters, repeat, shuffle, playlists, and SQLite-backed user saves. |

## `music-rainlink`

`music-rainlink` is the full music plugin for Pluxora. It is built for Lavalink nodes and uses Rainlink for playback, node connections, queue handling, filters, and audio routing.

### Features

- Lavalink v3 and v4 support through Rainlink.
- Multiple Lavalink nodes with failover.
- Slash and prefix command support through Pluxora.
- Rich embed replies for queue, now playing, playlist imports, and status messages.
- Now-playing progress bar.
- Message buttons for previous, play/pause, next, stop, shuffle, repeat, and save.
- Per-user saved playlists stored in SQLite through Sequelize.
- Playlist create, list, show, delete, save, load, and import actions.
- YouTube playlist import, preserving the source playlist name when no custom name is supplied.
- Repeat modes: off, song, and queue.
- Queue shuffle.
- Autoplay support when available from Rainlink.
- Filter presets from [`music-rainlink/filters.json`](music-rainlink/filters.json).
- Clean unload behavior to destroy active players and voice connections.

### Requirements

- Pluxora running on Node.js `20.11+`.
- `GuildVoiceStates` in Pluxora `config/core.json`:

```json
{
  "discord": {
    "intents": ["Guilds", "GuildVoiceStates"]
  }
}
```

- A reachable Lavalink v3 or v4 node.
- Plugin dependencies installed. Pluxora installs plugin dependencies on load/update. This plugin opts into install scripts because `sqlite3` may need native install steps.

### Dependencies

- `rainlink`
- `sequelize`
- `sqlite3`

### Commands

| Command | Aliases | What it does |
| --- | --- | --- |
| `/play <query>` |  | Plays a song, URL, or playlist through Lavalink. |
| `/pause` |  | Pauses playback. |
| `/resume` | `/unpause` | Resumes playback. |
| `/skip` | `/next` | Skips the current track. |
| `/stop` |  | Stops playback and clears the queue. |
| `/queue` | `/q` | Shows the current queue. |
| `/nowplaying` | `/np`, `/now` | Shows the current track and progress bar. |
| `/repeat <off/song/queue>` | `/loop` | Changes repeat mode. |
| `/shuffle` |  | Shuffles upcoming tracks. |
| `/filters <preset>` | `/filter` | Applies a filter preset, or resets filters. |
| `/playlist <action>` |  | Manages saved user playlists. |
| `/volume <0-150>` |  | Changes player volume. |
| `/autoplay <true/false>` |  | Toggles autoplay when supported. |

### Playlist Actions

`/playlist` supports:

- `create`: create a user playlist.
- `list`: list your playlists in the current guild.
- `show`: show saved tracks in a playlist.
- `delete`: delete one of your playlists.
- `save`: save the current track to a playlist.
- `load`: queue tracks from a saved playlist.
- `import`: import a YouTube playlist and save all resolved tracks.

The save button on now-playing embeds lets users save the current track. If they already have playlists, Pluxora shows a select menu; otherwise it creates `Saved Tracks`.

### Filter Presets

Default presets live in [`music-rainlink/filters.json`](music-rainlink/filters.json). Current presets:

```text
nightcore, xbox_mic, bassboost, vaporwave, karaoke, chipmunk,
3d, 8d, 360_audio, venum, punk, oldschool, hardstyle,
uptempo, frenchcore, reset
```

If a Rainlink/Lavalink build does not expose filter controls, the command fails cleanly instead of breaking playback.

### Basic Config

Plugin config lives at `config/plugins/music-rainlink.json` after installation. The source default is [`music-rainlink/config.json`](music-rainlink/config.json).

Minimum node config:

```json
{
  "lavalinkNodes": [
    {
      "name": "main-v4",
      "host": "127.0.0.1",
      "port": 2333,
      "auth": "youshallnotpass",
      "secure": false,
      "driver": "lavalink/v4"
    }
  ]
}
```

For Lavalink v3, use the matching Rainlink driver value for your node.

## Installing From Pluxora

1. Add the `pluxora-package` topic to this GitHub repository.
2. Open the Pluxora dashboard.
3. Go to **Plugins** -> **GitHub Discovery**.
4. Search for this repository.
5. Install `music-rainlink`.
6. Configure Lavalink in the plugin config.
7. Enable the plugin and sync slash commands if needed.

Owner command flow:

```text
!pluginsearch music
!plugin enable music-rainlink
!plugin sync-commands
```

## Repository Layout

```text
music-rainlink/
  package.json
  index.js
  config.json
  filters.json
```

## Notes

- This repository contains production plugins. For starter examples, use the `Pluxora-Example-Plugins` repository.
- Pluxora GitHub Discovery always searches the hardcoded `pluxora-package` topic.
- Review plugin updates before applying them in production, especially when dependencies or install scripts change.
- This repository uses the [NekoSunePlugins Restricted Source License](LICENSE). Stealing, redistributing, forking, rebranding, or using these plugins for malware, abuse, IP grabbing, token theft, or other harmful activity is not allowed without permission.
- Dependencies and community code keep their own licenses. Follow each dependency and plugin license.
