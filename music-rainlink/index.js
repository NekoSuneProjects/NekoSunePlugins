const path = require('node:path');
const fs = require('node:fs/promises');

let runtimeContext = null;
let Rainlink = null;
let Library = null;
let EmbedBuilder = null;
let ActionRowBuilder = null;
let ButtonBuilder = null;
let ButtonStyle = null;
let StringSelectMenuBuilder = null;
let StringSelectMenuOptionBuilder = null;
let Sequelize = null;
let DataTypes = null;
let RainlinkTrack = null;
let rainlink = null;
let rainlinkRawClient = null;
let sequelize = null;
let Playlist = null;
let PlaylistTrack = null;
let databaseReady = false;

let configuredNodes = [];
let activeNodeIndex = 0;
let failoverInProgress = false;

const rainlinkClientListeners = [];
const rainlinkClientImmediates = [];
const playerTextChannels = new Map();
const CONTROL_PREFIX = 'mrl';
const DEFAULT_PLAYLIST_NAME = 'Saved Tracks';

const MUSIC_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x57f287;
const WARNING_COLOR = 0xfee75c;
const ERROR_COLOR = 0xed4245;
const INFO_COLOR = 0x2b2d31;

const DEFAULT_CONFIG = {
  maxQueueSize: 50,
  volume: 0.65,
  leaveOnStop: true,
  leaveOnQueueEnd: true,
  autoplay: true,
  announceNowPlaying: true,
  announceTrackAdd: true,
  announceTrackEnd: false,
  announceQueueEnd: true,
  defaultSearchPlatform: 'youtube',
  filterPresets: null,
  lavalinkNodes: []
};

const SEARCH_ENGINE_ALIASES = {
  yt: 'youtube',
  youtube: 'youtube',
  ytsearch: 'youtube',
  sc: 'soundcloud',
  soundcloud: 'soundcloud',
  scsearch: 'soundcloud'
};

const DEFAULT_FILTER_PRESETS = require('./filters.json');

function getConfig(ctx, key, fallback) {
  try {
    if (typeof ctx?.getConfig === 'function') {
      const value = ctx.getConfig(key, fallback);
      if (value !== undefined) return value;
    }
  } catch {}

  return ctx?.config?.[key] ?? fallback;
}

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function normalizeSearchEngine(value) {
  const key = String(value || 'youtube').trim().toLowerCase();
  return SEARCH_ENGINE_ALIASES[key] || key || 'youtube';
}

function hasIntent(client, intent) {
  const intents = client?.options?.intents;
  if (!intents) return false;
  if (typeof intents.has === 'function') return intents.has(intent);

  const bitfield = intents.bitfield ?? intents;
  if (bitfield === undefined || bitfield === null) return false;

  try {
    return (BigInt(bitfield) & BigInt(intent)) === BigInt(intent);
  } catch {
    return false;
  }
}

function warnIfVoiceIntentMissing(ctx) {
  try {
    const { GatewayIntentBits } = require('discord.js');
    if (hasIntent(ctx.rawClient || ctx.client, GatewayIntentBits.GuildVoiceStates)) return;

    ctx.logger.error(
      'music-rainlink requires the GuildVoiceStates intent. Add "GuildVoiceStates" to discord.intents in config/core.json and enable the matching intent in Discord if needed.'
    );
  } catch (error) {
    ctx.logger.warning('music-rainlink could not verify Discord voice intents', { error: errorText(error) });
  }
}

async function setupDatabase(ctx) {
  try {
    ({ Sequelize, DataTypes } = require('sequelize'));

    const storagePath = ctx.storagePath || ctx.paths?.data || path.join(ctx.paths?.root || process.cwd(), 'data');
    await fs.mkdir(storagePath, { recursive: true });

    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: path.join(storagePath, 'music-rainlink.sqlite'),
      logging: false
    });

    Playlist = sequelize.define('Playlist', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      guildId: { type: DataTypes.STRING, allowNull: false },
      userId: { type: DataTypes.STRING, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      sourceName: { type: DataTypes.STRING, allowNull: true }
    }, {
      indexes: [
        { unique: true, fields: ['guildId', 'userId', 'name'] }
      ]
    });

    PlaylistTrack = sequelize.define('PlaylistTrack', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      playlistId: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      title: { type: DataTypes.STRING, allowNull: false },
      author: { type: DataTypes.STRING, allowNull: true },
      uri: { type: DataTypes.TEXT, allowNull: true },
      duration: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isStream: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      artworkUrl: { type: DataTypes.TEXT, allowNull: true },
      source: { type: DataTypes.STRING, allowNull: true },
      raw: { type: DataTypes.TEXT, allowNull: true }
    }, {
      indexes: [
        { fields: ['playlistId', 'position'] }
      ]
    });

    Playlist.hasMany(PlaylistTrack, { foreignKey: 'playlistId', as: 'tracks', onDelete: 'CASCADE' });
    PlaylistTrack.belongsTo(Playlist, { foreignKey: 'playlistId', as: 'playlist' });

    await sequelize.sync();
    databaseReady = true;
    ctx.logger.info('music-rainlink playlist database ready', { storage: sequelize.options.storage });
  } catch (error) {
    databaseReady = false;
    ctx.logger.warning('music-rainlink playlist database unavailable', {
      error: errorText(error),
      hint: 'Install plugin dependencies with scripts enabled for sqlite3 support.'
    });
  }
}

async function closeDatabase() {
  if (sequelize) {
    await sequelize.close().catch(() => {});
  }
  sequelize = null;
  Playlist = null;
  PlaylistTrack = null;
  databaseReady = false;
}

function assertDatabaseReady() {
  if (!databaseReady || !Playlist || !PlaylistTrack) {
    throw new Error('Playlist storage is unavailable. Install sequelize/sqlite3 dependencies for this plugin.');
  }
}

function normalizePlaylistName(name) {
  return trimText(String(name || DEFAULT_PLAYLIST_NAME).trim() || DEFAULT_PLAYLIST_NAME, 80);
}

async function userPlaylists(ctx) {
  assertDatabaseReady();
  return Playlist.findAll({
    where: { guildId: ctx.guildId, userId: ctx.user.id },
    order: [['updatedAt', 'DESC']]
  });
}

async function getPlaylist(ctx, name) {
  assertDatabaseReady();
  return Playlist.findOne({
    where: {
      guildId: ctx.guildId,
      userId: ctx.user.id,
      name: normalizePlaylistName(name)
    }
  });
}

async function ensurePlaylist(ctx, name, sourceName = null) {
  assertDatabaseReady();
  const playlistName = normalizePlaylistName(name);
  const [playlist] = await Playlist.findOrCreate({
    where: {
      guildId: ctx.guildId,
      userId: ctx.user.id,
      name: playlistName
    },
    defaults: {
      sourceName
    }
  });

  if (sourceName && playlist.sourceName !== sourceName) {
    playlist.sourceName = sourceName;
    await playlist.save();
  }

  return playlist;
}

function trackRecord(track, position) {
  return {
    position,
    title: track?.title || 'Unknown track',
    author: track?.author || null,
    uri: trackUrl(track),
    duration: Number(track?.duration || 0),
    isStream: Boolean(track?.isStream),
    artworkUrl: track?.artworkUrl || null,
    source: track?.source || null,
    raw: track?.raw ? JSON.stringify(track.raw) : null
  };
}

async function addTrackToPlaylist(playlist, track) {
  assertDatabaseReady();
  const maxPosition = await PlaylistTrack.max('position', { where: { playlistId: playlist.id } });
  return PlaylistTrack.create({
    playlistId: playlist.id,
    ...trackRecord(track, Number.isFinite(maxPosition) ? maxPosition + 1 : 0)
  });
}

async function replacePlaylistTracks(playlist, tracks) {
  assertDatabaseReady();
  await PlaylistTrack.destroy({ where: { playlistId: playlist.id } });
  if (!tracks.length) return [];

  return PlaylistTrack.bulkCreate(tracks.map((track, index) => ({
    playlistId: playlist.id,
    ...trackRecord(track, index)
  })));
}

async function playlistTracks(playlist) {
  assertDatabaseReady();
  return PlaylistTrack.findAll({
    where: { playlistId: playlist.id },
    order: [['position', 'ASC']]
  });
}

function getNodes(ctx) {
  const nodes = getConfig(ctx, 'lavalinkNodes', []);
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('music-rainlink: lavalinkNodes is empty. Configure at least one Lavalink node.');
  }

  return nodes.map((node, index) => ({
    name: node.name || `node-${index + 1}`,
    host: node.host,
    port: Number(node.port || 2333),
    auth: node.auth || node.password || 'youshallnotpass',
    secure: Boolean(node.secure),
    driver: node.driver || undefined
  }));
}

function rotateNodes(nodes, startIndex = 0) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const safeIndex = ((Number(startIndex) || 0) % nodes.length + nodes.length) % nodes.length;
  return [...nodes.slice(safeIndex), ...nodes.slice(0, safeIndex)];
}

function activeNodeName() {
  return configuredNodes[activeNodeIndex]?.name || null;
}

function createRainlinkClient(ctx) {
  const client = ctx.rawClient || ctx.client;
  rainlinkRawClient = client;

  let proxy = null;
  const listenerMethods = new Set([
    'on',
    'addListener',
    'once',
    'prependListener',
    'prependOnceListener'
  ]);

  function addListener(method, eventName, listener) {
    if (typeof listener !== 'function') {
      throw new Error(`Rainlink listener for "${eventName}" must be a function.`);
    }

    const readyEvent = eventName === 'ready' || eventName === 'clientReady';
    const once = method === 'once' || method === 'prependOnceListener';

    if (readyEvent && typeof client.isReady === 'function' && client.isReady()) {
      const immediate = setImmediate(() => {
        const index = rainlinkClientImmediates.indexOf(immediate);
        if (index !== -1) rainlinkClientImmediates.splice(index, 1);
        listener(client);
      });
      rainlinkClientImmediates.push(immediate);
      if (once) return proxy;
    }

    client[method](eventName, listener);
    rainlinkClientListeners.push({ eventName, listener });
    return proxy;
  }

  proxy = new Proxy(client, {
    get(target, property) {
      if (listenerMethods.has(property)) {
        return (eventName, listener) => addListener(property, eventName, listener);
      }

      if (property === 'off' || property === 'removeListener') {
        return (eventName, listener) => {
          removeRainlinkClientListener(eventName, listener);
          return proxy;
        };
      }

      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  return proxy;
}

function removeRainlinkClientListener(eventName, listener) {
  if (rainlinkRawClient?.removeListener) {
    rainlinkRawClient.removeListener(eventName, listener);
  }

  const index = rainlinkClientListeners.findIndex((entry) => (
    entry.eventName === eventName && entry.listener === listener
  ));
  if (index !== -1) rainlinkClientListeners.splice(index, 1);
}

function removeRainlinkClientListeners() {
  for (const immediate of rainlinkClientImmediates.splice(0)) {
    clearImmediate(immediate);
  }

  if (rainlinkRawClient?.removeListener) {
    for (const { eventName, listener } of rainlinkClientListeners.splice(0)) {
      rainlinkRawClient.removeListener(eventName, listener);
    }
  } else {
    rainlinkClientListeners.length = 0;
  }
  rainlinkRawClient = null;
}

function collectionEntries(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.full)) return collection.full;
  if (typeof collection[Symbol.iterator] === 'function') return collection;
  if (Array.isArray(collection.values)) return collection.values;
  if (typeof collection.values === 'function') return collection.values();
  if (typeof collection.forEach === 'function') {
    const entries = [];
    collection.forEach((value, key) => entries.push([key, value]));
    return entries;
  }
  if (collection.cache && typeof collection.cache === 'object') return Object.entries(collection.cache);
  return Object.entries(collection);
}

function entryValue(entry) {
  return Array.isArray(entry) && entry.length === 2 ? entry[1] : entry;
}

async function teardownRainlink(ctx, options = {}) {
  const current = rainlink;
  rainlink = null;

  if (!current) {
    removeRainlinkClientListeners();
    return;
  }

  for (const entry of collectionEntries(current.players)) {
    const player = entryValue(entry);
    if (typeof player?.destroy === 'function') {
      await player.destroy().catch((error) => {
        ctx?.logger?.warning?.('Failed to destroy Rainlink player', { error: errorText(error) });
      });
    }
  }

  for (const entry of collectionEntries(current.nodes)) {
    const node = entryValue(entry);
    try {
      if (typeof node?.disconnect === 'function') node.disconnect();
    } catch (error) {
      ctx?.logger?.warning?.('Failed to disconnect Rainlink node', { error: errorText(error) });
    }
  }

  if (typeof current.destroy === 'function' && current.destroy.length === 0) {
    await current.destroy().catch((error) => {
      ctx?.logger?.warning?.('Failed to destroy Rainlink manager', { error: errorText(error) });
    });
  }

  removeRainlinkClientListeners();
  if (options.clearTextChannels) playerTextChannels.clear();
}

function voiceChannelFor(ctx) {
  const member = ctx.guild?.members?.cache?.get?.(ctx.user?.id) || ctx.member;
  return member?.voice?.channel || null;
}

function queryText(ctx) {
  return (ctx.options?.query || ctx.args?.join(' ') || '').trim();
}

function queueLength(player) {
  const queue = player?.queue;
  if (!queue) return 0;
  if (typeof queue.totalSize === 'number') return queue.totalSize;
  if (Array.isArray(queue)) return queue.length + (queue.current ? 1 : 0);
  if (Array.isArray(queue.tracks)) return queue.tracks.length + (queue.current ? 1 : 0);
  if (typeof queue.size === 'number') return queue.size + (queue.current ? 1 : 0);
  return queue.current ? 1 : 0;
}

function queuedTracks(player) {
  const queue = player?.queue;
  if (!queue) return [];
  if (Array.isArray(queue)) return [...queue];
  if (Array.isArray(queue.tracks)) return queue.tracks;
  if (typeof queue.values === 'function') return Array.from(queue.values());
  return [];
}

function currentTrack(player) {
  return player?.queue?.current || player?.current || player?.nowPlaying || null;
}

function isPlaylistResult(result) {
  const type = String(result?.type || result?.loadType || '').toUpperCase();
  return type === 'PLAYLIST' || type === 'PLAYLIST_LOADED';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function trimText(value, maxLength = 100) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function limitedLines(lines, maxLength = 1000) {
  const output = [];
  let length = 0;

  for (const line of lines) {
    const nextLength = length + line.length + (output.length ? 1 : 0);
    if (nextLength > maxLength) break;
    output.push(line);
    length = nextLength;
  }

  if (output.length < lines.length) {
    output.push(`...and ${lines.length - output.length} more`);
  }

  return output.join('\n');
}

function escapeMarkdown(value) {
  return String(value || '').replace(/([\\[\]()`*_~])/g, '\\$1');
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return '0:00';

  const totalSeconds = Math.floor(value / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function requesterName(requester) {
  return requester?.globalName || requester?.username || requester?.tag || requester?.id || 'Unknown';
}

function trackTitle(track) {
  return trimText(track?.title || 'Unknown track', 110);
}

function trackUrl(track) {
  return track?.uri || track?.realUri || null;
}

function trackLine(track, index = null) {
  const prefix = index === null ? '' : `**${index}.** `;
  const title = escapeMarkdown(trackTitle(track));
  const url = trackUrl(track);
  const linkedTitle = url ? `[${title}](${url})` : title;
  const author = track?.author ? ` - ${escapeMarkdown(trimText(track.author, 40))}` : '';
  const duration = track?.isStream ? 'LIVE' : formatDuration(track?.duration);
  return `${prefix}${linkedTitle}${author} \`${duration}\``;
}

function queueDuration(player) {
  const current = currentTrack(player);
  const tracks = queuedTracks(player);
  return [current, ...tracks].reduce((total, track) => {
    if (track?.isStream) return total;
    return total + Number(track?.duration || 0);
  }, 0);
}

function playerPosition(player, track = currentTrack(player)) {
  if (!track || track.isStream) return 0;
  const duration = Number(track.duration || 0);
  const position = Number(player?.position || track?.position || 0);
  return duration > 0 ? clamp(position, 0, duration) : Math.max(0, position);
}

function progressBar(position, duration, size = 18) {
  if (!duration || duration <= 0) return '[------------------]';
  const ratio = clamp(position / duration, 0, 1);
  const marker = clamp(Math.round(ratio * (size - 1)), 0, size - 1);
  return `[${'='.repeat(marker)}>${'-'.repeat(size - marker - 1)}]`;
}

function embedBase(title, color = MUSIC_COLOR) {
  if (!EmbedBuilder) return null;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp();
}

function embedPayload(embed, fallback, components = []) {
  const payload = embed ? { embeds: [embed] } : { content: fallback };
  if (components.length) payload.components = components;
  return payload;
}

function controlId(action, guildId, extra = null) {
  return [CONTROL_PREFIX, action, guildId, extra].filter((part) => part !== null && part !== undefined).join(':');
}

function controlRows(player) {
  if (!ActionRowBuilder || !ButtonBuilder || !ButtonStyle) return [];

  const guildId = player?.guildId || player?.guildID || player?.guild;
  if (!guildId) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(controlId('previous', guildId))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(controlId('toggle', guildId))
        .setLabel(player?.paused ? 'Play' : 'Pause')
        .setStyle(player?.paused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(controlId('next', guildId))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(controlId('stop', guildId))
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(controlId('shuffle', guildId))
        .setLabel('Shuffle')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(controlId('repeat_off', guildId))
        .setLabel('Repeat Off')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(controlId('repeat_song', guildId))
        .setLabel('Repeat Song')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(controlId('repeat_queue', guildId))
        .setLabel('Repeat Queue')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(controlId('save', guildId))
        .setLabel('Save')
        .setStyle(ButtonStyle.Success)
    )
  ];
}

function playerPayload(embed, fallback, player) {
  return embedPayload(embed, fallback, controlRows(player));
}

function playerFooter(player) {
  const parts = [
    `Node: ${activeNodeName() || 'unknown'}`,
    `Volume: ${Math.round(Number(player?.volume || 0))}%`,
    `Repeat: ${player?.loop || 'none'}`,
    `Queue: ${Math.max(0, queueLength(player) - (currentTrack(player) ? 1 : 0))}`
  ];
  return parts.join(' | ');
}

function nowPlayingEmbed(player, track = currentTrack(player)) {
  if (!track) return null;

  const embed = embedBase(player?.paused ? 'Paused' : 'Now Playing', player?.paused ? WARNING_COLOR : MUSIC_COLOR);
  if (!embed) return null;

  const position = playerPosition(player, track);
  const duration = Number(track.duration || 0);
  const progress = track.isStream
    ? '`LIVE STREAM`'
    : `\`${progressBar(position, duration)}\`\n\`${formatDuration(position)} / ${formatDuration(duration)}\``;

  embed
    .setDescription(trackLine(track))
    .addFields(
      { name: 'Author', value: escapeMarkdown(track?.author || 'Unknown'), inline: true },
      { name: 'Requested By', value: escapeMarkdown(requesterName(track?.requester)), inline: true },
      { name: 'Duration', value: track.isStream ? 'LIVE' : formatDuration(duration), inline: true },
      { name: 'Progress', value: progress, inline: false }
    )
    .setFooter({ text: playerFooter(player) });

  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  return embed;
}

function queuedTrackEmbed(track, player, title = 'Queued Track') {
  const embed = embedBase(title, SUCCESS_COLOR);
  if (!embed) return null;

  embed
    .setDescription(trackLine(track))
    .addFields(
      { name: 'Author', value: escapeMarkdown(track?.author || 'Unknown'), inline: true },
      { name: 'Duration', value: track?.isStream ? 'LIVE' : formatDuration(track?.duration), inline: true },
      { name: 'Queue Position', value: String(Math.max(1, queueLength(player))), inline: true }
    )
    .setFooter({ text: playerFooter(player) });

  if (track?.artworkUrl) embed.setThumbnail(track.artworkUrl);
  return embed;
}

function playlistQueuedEmbed(result, tracks, player) {
  const embed = embedBase('Queued Playlist', SUCCESS_COLOR);
  if (!embed) return null;

  const preview = limitedLines(
    tracks.slice(0, 8).map((track, index) => trackLine(track, index + 1))
  );
  embed
    .setDescription(`**${escapeMarkdown(result.playlistName || 'Playlist')}**`)
    .addFields(
      { name: 'Added', value: String(tracks.length), inline: true },
      { name: 'Queue Total', value: String(queueLength(player)), inline: true },
      { name: 'Duration', value: formatDuration(queueDuration(player)), inline: true },
      { name: 'Tracks', value: preview || 'No tracks added.', inline: false }
    )
    .setFooter({ text: playerFooter(player) });

  return embed;
}

function queueEmbed(player) {
  const embed = embedBase('Music Queue', INFO_COLOR);
  if (!embed) return null;

  const current = currentTrack(player);
  const tracks = queuedTracks(player);
  const upcoming = limitedLines(tracks.slice(0, 10).map((track, index) => trackLine(track, index + 1)));

  if (current) {
    const position = playerPosition(player, current);
    const progress = current.isStream
      ? '`LIVE STREAM`'
      : `\`${progressBar(position, current.duration)}\` \`${formatDuration(position)} / ${formatDuration(current.duration)}\``;
    embed.addFields({
      name: 'Now Playing',
      value: `${trackLine(current)}\n${progress}`,
      inline: false
    });
    if (current.artworkUrl) embed.setThumbnail(current.artworkUrl);
  }

  embed
    .addFields(
      { name: 'Up Next', value: upcoming || 'No more tracks queued.', inline: false },
      { name: 'Tracks', value: String(queueLength(player)), inline: true },
      { name: 'Total Duration', value: formatDuration(queueDuration(player)), inline: true },
      { name: 'Status', value: player?.paused ? 'Paused' : (player?.playing ? 'Playing' : 'Idle'), inline: true }
    )
    .setFooter({
      text: tracks.length > 10
        ? `${playerFooter(player)} | Showing 10 of ${tracks.length} upcoming`
        : playerFooter(player)
    });

  return embed;
}

function queueText(player) {
  const current = currentTrack(player);
  const tracks = queuedTracks(player);
  const lines = [];
  if (current) lines.push(`Now: ${trackTitle(current)}`);
  tracks.slice(0, 10).forEach((track, index) => {
    lines.push(`${index + 1}. ${trackTitle(track)} (${track?.isStream ? 'LIVE' : formatDuration(track?.duration)})`);
  });
  if (tracks.length > 10) lines.push(`...and ${tracks.length - 10} more`);
  return lines.join('\n') || 'Queue is empty.';
}

function playlistEmbed(title, description, rows = [], color = INFO_COLOR) {
  const embed = embedBase(title, color);
  if (!embed) return null;
  embed.setDescription(description);

  if (rows.length) {
    embed.addFields({
      name: 'Tracks',
      value: limitedLines(rows.map((row, index) => {
        const titleText = row.title || row.name || 'Unknown track';
        const duration = row.isStream ? 'LIVE' : formatDuration(row.duration);
        return `**${index + 1}.** ${escapeMarkdown(trimText(titleText, 80))} \`${duration}\``;
      }), 1000),
      inline: false
    });
  }

  return embed;
}

async function savedRecordToTrack(record, requester) {
  if (record.raw && RainlinkTrack) {
    try {
      return new RainlinkTrack(JSON.parse(record.raw), requester, record.source || undefined);
    } catch {}
  }

  const query = record.uri || `${record.title || ''} ${record.author || ''}`.trim();
  if (!query) return null;
  const result = await rainlink.search(query, {
    requester,
    engine: normalizeSearchEngine(getConfig(runtimeContext, 'defaultSearchPlatform', 'youtube'))
  });
  return result?.tracks?.[0] || null;
}

async function playlistRecordsToTracks(records, requester) {
  const tracks = [];
  for (const record of records) {
    const track = await savedRecordToTrack(record, requester).catch(() => null);
    if (track) tracks.push(track);
  }
  return tracks;
}

function getFilterPresets(ctx) {
  const configured = getConfig(ctx, 'filterPresets', null);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return DEFAULT_FILTER_PRESETS;
  }
  return { ...DEFAULT_FILTER_PRESETS, ...configured };
}

function filterDisplayName(name) {
  return String(name || '').replace(/_/g, ' ').toUpperCase();
}

function sanitizeFilterPreset(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return {};
  const allowed = [
    'volume',
    'equalizer',
    'karaoke',
    'timescale',
    'tremolo',
    'vibrato',
    'rotation',
    'distortion',
    'channelMix',
    'lowPass'
  ];
  return Object.fromEntries(Object.entries(preset).filter(([key, value]) => (
    allowed.includes(key) && value !== null && value !== undefined
  )));
}

async function applyFilterPreset(player, presetName, preset) {
  const filters = player?.filters || player?.filter;
  if (!filters) return { applied: false, reason: 'filters unsupported' };

  const cleanPreset = sanitizeFilterPreset(preset);
  if (!Object.keys(cleanPreset).length) {
    if (typeof filters.clear === 'function') await filters.clear();
    if (player.data?.set) player.data.set('filterPreset', 'reset');
    return { applied: true, reset: true };
  }

  if (typeof filters.setRaw === 'function') {
    await filters.setRaw(cleanPreset);
    if (player.data?.set) player.data.set('filterPreset', presetName);
    return { applied: true };
  }

  const handlers = {
    volume: 'setVolume',
    equalizer: 'setEqualizer',
    karaoke: 'setKaraoke',
    timescale: 'setTimescale',
    tremolo: 'setTremolo',
    vibrato: 'setVibrato',
    rotation: 'setRotation',
    distortion: 'setDistortion',
    channelMix: 'setChannelMix',
    lowPass: 'setLowPass'
  };

  if (typeof filters.clear === 'function') await filters.clear();
  for (const [filterName, filterValue] of Object.entries(cleanPreset)) {
    const method = handlers[filterName];
    if (method && typeof filters[method] === 'function') {
      await filters[method](filterValue);
    }
  }
  if (player.data?.set) player.data.set('filterPreset', presetName);
  return { applied: true };
}

function statusEmbed(title, description, player = null, color = MUSIC_COLOR) {
  const embed = embedBase(title, color);
  if (!embed) return null;
  embed.setDescription(description);
  if (player) embed.setFooter({ text: playerFooter(player) });
  return embed;
}

async function announce(player, payload) {
  const channelId = playerTextChannels.get(player.guildId || player.guildID || player.guild);
  const client = runtimeContext?.rawClient || runtimeContext?.client;
  if (!channelId || !client?.channels?.fetch) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.send) await channel.send(typeof payload === 'string' ? { content: payload } : payload);
  } catch (error) {
    runtimeContext?.logger?.warning?.('Failed to send music announcement', {
      error: errorText(error)
    });
  }
}

async function maybeFailover(ctx, node, reason) {
  if (configuredNodes.length < 2 || failoverInProgress) return;

  const failingName = node?.options?.name || node?.name;
  const currentName = activeNodeName();
  if (failingName && currentName && failingName !== currentName) return;

  failoverInProgress = true;
  try {
    const nextIndex = (activeNodeIndex + 1) % configuredNodes.length;
    ctx.logger.warning('Failing over Lavalink node', {
      from: currentName || 'unknown',
      to: configuredNodes[nextIndex]?.name || 'unknown',
      reason
    });
    await setupRainlink(ctx, nextIndex);
  } catch (error) {
    ctx.logger.error('Lavalink failover failed', { error: errorText(error) });
  } finally {
    failoverInProgress = false;
  }
}

async function setupRainlink(ctx, startIndex = 0) {
  if (!configuredNodes.length) configuredNodes = getNodes(ctx);
  activeNodeIndex = ((Number(startIndex) || 0) % configuredNodes.length + configuredNodes.length) % configuredNodes.length;

  await teardownRainlink(ctx, { clearTextChannels: false });

  const nodes = rotateNodes(configuredNodes, activeNodeIndex);
  const defaultVolume = Math.round(Number(getConfig(ctx, 'volume', 0.65)) * 100);

  rainlink = new Rainlink({
    library: new Library.DiscordJS(createRainlinkClient(ctx)),
    nodes,
    options: {
      defaultSearchEngine: normalizeSearchEngine(getConfig(ctx, 'defaultSearchPlatform', 'youtube')),
      defaultVolume
    }
  });

  rainlink.on('nodeConnect', (node) => {
    ctx.logger.info('Lavalink node connected', { node: node?.options?.name || node?.name });
  });

  rainlink.on('nodeError', (node, error) => {
    ctx.logger.error('Lavalink node error', {
      node: node?.options?.name || node?.name,
      error: errorText(error)
    });
    void maybeFailover(ctx, node, 'nodeError');
  });

  rainlink.on('nodeClosed', (node) => {
    ctx.logger.warning('Lavalink node closed', { node: node?.options?.name || node?.name });
    void maybeFailover(ctx, node, 'nodeClosed');
  });

  rainlink.on('nodeDisconnect', (node, code, reason) => {
    ctx.logger.warning('Lavalink node disconnected', {
      node: node?.options?.name || node?.name,
      code,
      reason: reason || 'No reason'
    });
    void maybeFailover(ctx, node, 'nodeDisconnect');
  });

  rainlink.on('trackStart', (player, track) => {
    if (getConfig(ctx, 'announceNowPlaying', true)) {
      void announce(
        player,
        playerPayload(nowPlayingEmbed(player, track), `Now playing: ${track?.title || 'Unknown track'}`, player)
      );
    }
  });

  rainlink.on('trackEnd', (player, track) => {
    if (getConfig(ctx, 'announceTrackEnd', false)) {
      const embed = statusEmbed(
        'Track Finished',
        track ? trackLine(track) : 'Finished current track.',
        player,
        INFO_COLOR
      );
      void announce(player, embedPayload(embed, `Finished: ${track?.title || 'Track'}`));
    }
  });

  rainlink.on('queueEmpty', async (player) => {
    if (getConfig(ctx, 'announceQueueEnd', true)) {
      const embed = statusEmbed('Queue Ended', 'No more tracks are queued.', player, INFO_COLOR);
      await announce(player, embedPayload(embed, 'Queue ended.'));
    }

    if (getConfig(ctx, 'leaveOnQueueEnd', true) && typeof player?.destroy === 'function') {
      await player.destroy().catch(() => {});
    }
  });

  ctx.logger.info('music-rainlink active node', { node: activeNodeName() || 'unknown' });
}

async function applyAutoplay(ctx, player) {
  const enabled = Boolean(getConfig(ctx, 'autoplay', true));
  if (typeof player?.setAutoplay === 'function') {
    await player.setAutoplay(enabled);
  } else if (player && 'autoplay' in player) {
    player.autoplay = enabled;
  }
}

async function getOrCreatePlayer(ctx, voiceChannel, textChannelId) {
  if (!rainlink) throw new Error('Rainlink is not ready.');
  if (!voiceChannel) throw new Error('No voice channel.');

  let player = rainlink.players.get(ctx.guildId);
  if (!player) {
    player = await rainlink.create({
      guildId: ctx.guildId,
      textId: textChannelId,
      voiceId: voiceChannel.id,
      shardId: ctx.guild?.shardId || 0,
      volume: Math.round(Number(getConfig(ctx, 'volume', 0.65)) * 100)
    });
  } else if (player.voiceId !== voiceChannel.id) {
    if (typeof player.setVoiceChannel === 'function') player.setVoiceChannel(voiceChannel.id);
    else if (typeof player.connect === 'function') await player.connect();
  }

  if (typeof player.setTextChannel === 'function') player.setTextChannel(textChannelId);
  await applyAutoplay(ctx, player);
  playerTextChannels.set(ctx.guildId, textChannelId);
  return player;
}

async function searchTracks(ctx, query) {
  const result = await rainlink.search(query, {
    requester: ctx.user,
    engine: normalizeSearchEngine(getConfig(ctx, 'defaultSearchPlatform', 'youtube'))
  });

  if (!result?.tracks?.length) {
    throw new Error('No tracks found for your query.');
  }

  return result;
}

async function safePlay(player) {
  if (!player || player.playing || !queueLength(player)) return;
  if (player.paused && player.track) return;
  await player.play();
  if (player.paused && typeof player.setPause === 'function') {
    await player.setPause(false);
  } else if (player.paused) {
    player.paused = false;
    player.playing = true;
  }
}

function getPlayer(ctx) {
  return rainlink?.players?.get?.(ctx.guildId) || null;
}

async function pausePlayer(player) {
  if (typeof player.pause === 'function') return player.pause();
  if (typeof player.setPause === 'function') return player.setPause(true);
  throw new Error('This Rainlink build does not support pause.');
}

async function resumePlayer(player) {
  if (typeof player.resume === 'function') return player.resume();
  if (typeof player.setPause === 'function') return player.setPause(false);
  throw new Error('This Rainlink build does not support resume.');
}

async function setRepeatMode(player, mode) {
  const mapped = {
    off: 'none',
    none: 'none',
    song: 'song',
    track: 'song',
    queue: 'queue',
    playlist: 'queue'
  }[String(mode || 'off').toLowerCase()] || 'none';

  if (typeof player.setLoop === 'function') player.setLoop(mapped);
  else player.loop = mapped;
  return mapped;
}

async function shufflePlayer(player) {
  const tracks = queuedTracks(player);
  if (!tracks.length) throw new Error('There are no upcoming tracks to shuffle.');
  if (typeof player.queue?.shuffle === 'function') player.queue.shuffle();
  else {
    for (let index = tracks.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [tracks[index], tracks[swapIndex]] = [tracks[swapIndex], tracks[index]];
    }
  }
}

async function stopPlayback(player) {
  if (typeof player.queue?.clear === 'function') player.queue.clear();
  else if (Array.isArray(player.queue)) player.queue.length = 0;

  if (typeof player.stop === 'function') await player.stop(false).catch(() => {});
  if (getConfig(runtimeContext, 'leaveOnStop', true) && typeof player.destroy === 'function') {
    await player.destroy();
  }
}

function sameVoiceChannel(interaction, player) {
  const memberChannelId = interaction.member?.voice?.channelId || interaction.member?.voice?.channel?.id;
  return Boolean(memberChannelId && (!player?.voiceId || memberChannelId === player.voiceId));
}

async function replyEphemeral(interaction, payload) {
  const nextPayload = typeof payload === 'string' ? { content: payload } : payload;
  nextPayload.ephemeral = true;

  if (interaction.replied || interaction.deferred) return interaction.followUp(nextPayload);
  return interaction.reply(nextPayload);
}

async function updateControlMessage(interaction, player, fallback = 'Updated player controls.') {
  const current = currentTrack(player);
  const embed = current
    ? nowPlayingEmbed(player, current)
    : statusEmbed('Player Updated', fallback, player, INFO_COLOR);

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(playerPayload(embed, fallback, player));
  }

  return interaction.update(playerPayload(embed, fallback, player));
}

async function showSaveSelect(ctx, interaction, player) {
  assertDatabaseReady();
  const track = currentTrack(player);
  if (!track) return replyEphemeral(interaction, 'There is no current track to save.');

  const playlists = await userPlaylists({
    guildId: interaction.guildId,
    user: interaction.user
  });

  if (!playlists.length) {
    const playlist = await ensurePlaylist({ guildId: interaction.guildId, user: interaction.user }, DEFAULT_PLAYLIST_NAME);
    await addTrackToPlaylist(playlist, track);
    const embed = statusEmbed('Saved Track', `Saved ${trackLine(track)} to **${escapeMarkdown(playlist.name)}**.`, player, SUCCESS_COLOR);
    return replyEphemeral(interaction, embedPayload(embed, `Saved to ${playlist.name}.`));
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(controlId('save_select', interaction.guildId, interaction.user.id))
    .setPlaceholder('Choose a playlist')
    .addOptions(playlists.slice(0, 25).map((playlist) => (
      new StringSelectMenuOptionBuilder()
        .setLabel(trimText(playlist.name, 80))
        .setValue(String(playlist.id))
        .setDescription(trimText(`Updated ${playlist.updatedAt?.toISOString?.() || 'recently'}`, 90))
    )));

  const row = new ActionRowBuilder().addComponents(select);
  return replyEphemeral(interaction, {
    content: 'Choose a playlist to save the current track.',
    components: [row]
  });
}

async function handleSaveSelect(interaction) {
  assertDatabaseReady();
  const [, , guildId, userId] = interaction.customId.split(':');
  if (interaction.user.id !== userId) {
    return replyEphemeral(interaction, 'This playlist selector belongs to another user.');
  }

  const player = rainlink?.players?.get?.(guildId);
  const track = currentTrack(player);
  if (!player || !track) return replyEphemeral(interaction, 'There is no current track to save.');

  const playlist = await Playlist.findOne({
    where: {
      id: interaction.values[0],
      guildId,
      userId
    }
  });
  if (!playlist) return replyEphemeral(interaction, 'Playlist not found.');

  await addTrackToPlaylist(playlist, track);
  const embed = statusEmbed('Saved Track', `Saved ${trackLine(track)} to **${escapeMarkdown(playlist.name)}**.`, player, SUCCESS_COLOR);
  if (interaction.deferred || interaction.replied) return interaction.editReply(embedPayload(embed, `Saved to ${playlist.name}.`, []));
  return interaction.update(embedPayload(embed, `Saved to ${playlist.name}.`, []));
}

async function handleControlInteraction(ctx, interaction) {
  if (!interaction?.customId?.startsWith(`${CONTROL_PREFIX}:`)) return;

  try {
    if (interaction.isStringSelectMenu?.()) {
      const [, action] = interaction.customId.split(':');
      if (action === 'save_select') await handleSaveSelect(interaction);
      return;
    }

    if (!interaction.isButton?.()) return;

    const [, action, guildId] = interaction.customId.split(':');
    if (!guildId || guildId !== interaction.guildId) {
      return replyEphemeral(interaction, 'These controls are for another guild.');
    }

    const player = rainlink?.players?.get?.(guildId);
    if (!player) return replyEphemeral(interaction, 'There is no active player for this guild.');
    if (!sameVoiceChannel(interaction, player)) {
      return replyEphemeral(interaction, 'You need to be in the same voice channel as the bot.');
    }

    if (action === 'save') return showSaveSelect(ctx, interaction, player);

    if (action === 'toggle') {
      if (player.paused) await resumePlayer(player);
      else await pausePlayer(player);
      return updateControlMessage(interaction, player, player.paused ? 'Paused.' : 'Resumed.');
    }

    if (action === 'previous') {
      if (typeof player.previous !== 'function') return replyEphemeral(interaction, 'Previous track is not supported by this Rainlink build.');
      await player.previous();
      await safePlay(player);
      return updateControlMessage(interaction, player, 'Returned to previous track.');
    }

    if (action === 'next') {
      if (!currentTrack(player)) return replyEphemeral(interaction, 'There is no track to skip.');
      if (typeof player.skip === 'function') await player.skip();
      else if (typeof player.stop === 'function') await player.stop(false);
      await safePlay(player);
      return updateControlMessage(interaction, player, 'Skipped.');
    }

    if (action === 'stop') {
      await stopPlayback(player);
      const embed = statusEmbed('Playback Stopped', 'Queue cleared and playback stopped.', null, SUCCESS_COLOR);
      return interaction.update(embedPayload(embed, 'Stopped.', []));
    }

    if (action === 'shuffle') {
      await shufflePlayer(player);
      return updateControlMessage(interaction, player, 'Queue shuffled.');
    }

    if (action === 'repeat_off' || action === 'repeat_song' || action === 'repeat_queue') {
      const mode = action.replace('repeat_', '');
      const loop = await setRepeatMode(player, mode);
      return updateControlMessage(interaction, player, `Repeat set to ${loop}.`);
    }
  } catch (error) {
    ctx.logger.error('music control interaction failed', { error: errorText(error) });
    return replyEphemeral(interaction, error?.message || 'Music control failed.');
  }
}

module.exports = {
  defaultConfig: DEFAULT_CONFIG,

  async load(ctx) {
    runtimeContext = ctx;
    ({ Rainlink, Library, RainlinkTrack } = require('rainlink'));
    ({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      StringSelectMenuOptionBuilder
    } = require('discord.js'));

    warnIfVoiceIntentMissing(ctx);
    await setupDatabase(ctx);
    configuredNodes = getNodes(ctx);
    await setupRainlink(ctx, 0);
    ctx.logger.info('music-rainlink loaded successfully');
  },

  async unload() {
    await teardownRainlink(runtimeContext, { clearTextChannels: true });
    await closeDatabase();
    runtimeContext = null;
  },

  events: [
    {
      name: 'interactionCreate',
      async execute(ctx, interaction) {
        await handleControlInteraction(ctx, interaction);
      }
    }
  ],

  commands: [
    {
      name: 'play',
      description: 'Play tracks via Lavalink.',
      cooldownMs: 1500,
      options: [
        {
          name: 'query',
          description: 'Song name, URL, or playlist',
          type: 'string',
          required: true
        }
      ],
      async execute(ctx) {
        try {
          if (!ctx.guildId) {
            const embed = statusEmbed('Guild Only', 'Music commands must be used in a guild.', null, ERROR_COLOR);
            return ctx.reply(embedPayload(embed, 'Music commands must be used in a guild.'));
          }

          const voiceChannel = voiceChannelFor(ctx);
          if (!voiceChannel) {
            const embed = statusEmbed('Voice Channel Required', 'Join a voice channel first.', null, WARNING_COLOR);
            return ctx.reply(embedPayload(embed, 'Join a voice channel first.'));
          }

          const query = queryText(ctx);
          if (!query) {
            const embed = statusEmbed('Missing Query', 'Provide a song name, URL, or playlist.', null, WARNING_COLOR);
            return ctx.reply(embedPayload(embed, 'Provide a song name, URL, or playlist.'));
          }

          const textChannelId = ctx.message?.channel?.id || ctx.interaction?.channel?.id;
          const player = await getOrCreatePlayer(ctx, voiceChannel, textChannelId);
          const maxQueueSize = Number(getConfig(ctx, 'maxQueueSize', 50));

          if (queueLength(player) >= maxQueueSize) {
            const embed = statusEmbed('Queue Full', `Queue limit reached (${maxQueueSize}).`, player, WARNING_COLOR);
            return ctx.reply(embedPayload(embed, `Queue limit reached (${maxQueueSize}).`));
          }

          const result = await searchTracks(ctx, query);
          if (isPlaylistResult(result)) {
            const available = Math.max(0, maxQueueSize - queueLength(player));
            const tracks = result.tracks.slice(0, available);
            player.queue.add(tracks);
            await safePlay(player);

            if (getConfig(ctx, 'announceTrackAdd', true)) {
              await announce(
                player,
                embedPayload(
                  playlistQueuedEmbed(result, tracks, player),
                  `Queued ${tracks.length} tracks from ${result.playlistName || 'playlist'}.`
                )
              );
            }

            return ctx.reply(playerPayload(
              playlistQueuedEmbed(result, tracks, player),
              `Queued ${tracks.length} tracks from ${result.playlistName || 'playlist'}.`,
              player
            ));
          }

          const track = result.tracks[0];
          player.queue.add(track);
          await safePlay(player);

          if (getConfig(ctx, 'announceTrackAdd', true)) {
            await announce(
              player,
              embedPayload(queuedTrackEmbed(track, player), `Queued: ${track.title || 'Unknown track'}`)
            );
          }

          return ctx.reply(playerPayload(queuedTrackEmbed(track, player), `Queued: ${track.title || 'Unknown track'}`, player));
        } catch (error) {
          ctx.logger.error('play command failed', { error: errorText(error) });
          const embed = statusEmbed('Playback Error', error?.message || 'Unknown error', null, ERROR_COLOR);
          return ctx.reply(embedPayload(embed, `Could not play track: ${error?.message || 'Unknown error'}`));
        }
      }
    },
    {
      name: 'pause',
      description: 'Pause playback.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player || player.paused || !player.playing) {
          const embed = statusEmbed('Nothing To Pause', 'There is no active playback to pause.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing to pause.'));
        }
        await pausePlayer(player);
        return ctx.reply(playerPayload(nowPlayingEmbed(player), 'Paused.', player));
      }
    },
    {
      name: 'resume',
      aliases: ['unpause'],
      description: 'Resume playback.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player || !player.paused) {
          const embed = statusEmbed('Nothing Paused', 'There is no paused track to resume.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing paused.'));
        }
        await resumePlayer(player);
        return ctx.reply(playerPayload(nowPlayingEmbed(player), 'Resumed.', player));
      }
    },
    {
      name: 'skip',
      description: 'Skip current track.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        const skipped = currentTrack(player);
        if (!player || !skipped) {
          const embed = statusEmbed('Nothing Playing', 'There is no track to skip.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }
        if (typeof player.skip === 'function') await player.skip();
        else if (typeof player.stop === 'function') await player.stop(false);
        await safePlay(player);
        const next = currentTrack(player);
        const embed = next
          ? nowPlayingEmbed(player, next)
          : statusEmbed('Skipped', `Skipped ${trackLine(skipped)}.`, player, SUCCESS_COLOR);
        return ctx.reply(playerPayload(embed, 'Skipped.', player));
      }
    },
    {
      name: 'stop',
      description: 'Stop playback and clear the queue.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        if (typeof player.queue?.clear === 'function') player.queue.clear();
        else if (Array.isArray(player.queue)) player.queue.length = 0;

        if (typeof player.stop === 'function') await player.stop(false).catch(() => {});
        if (getConfig(ctx, 'leaveOnStop', true) && typeof player.destroy === 'function') {
          await player.destroy();
        }

        const embed = statusEmbed('Playback Stopped', 'Queue cleared and playback stopped.', null, SUCCESS_COLOR);
        return ctx.reply(embedPayload(embed, 'Stopped and queue cleared.'));
      }
    },
    {
      name: 'queue',
      description: 'Show the current queue.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Queue Empty', 'There is no active player for this guild.', null, INFO_COLOR);
          return ctx.reply(embedPayload(embed, 'Queue is empty.'));
        }

        const current = currentTrack(player);
        const tracks = queuedTracks(player);
        if (!current && tracks.length === 0) {
          const embed = statusEmbed('Queue Empty', 'There are no tracks queued.', player, INFO_COLOR);
          return ctx.reply(embedPayload(embed, 'Queue is empty.'));
        }

        return ctx.reply(playerPayload(queueEmbed(player), queueText(player), player));
      }
    },
    {
      name: 'nowplaying',
      aliases: ['np', 'now'],
      description: 'Show the current track and progress.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        const current = currentTrack(player);
        if (!player || !current) {
          const embed = statusEmbed('Nothing Playing', 'There is no current track.', player, INFO_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        return ctx.reply(playerPayload(nowPlayingEmbed(player, current), `Now playing: ${current.title || 'Unknown track'}`, player));
      }
    },
    {
      name: 'repeat',
      aliases: ['loop'],
      description: 'Set repeat mode.',
      options: [
        {
          name: 'mode',
          description: 'Repeat mode',
          type: 'string',
          required: true,
          choices: [
            { name: 'Off', value: 'off' },
            { name: 'Song', value: 'song' },
            { name: 'Queue', value: 'queue' }
          ]
        }
      ],
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        const loop = await setRepeatMode(player, ctx.options?.mode || ctx.args?.[0] || 'off');
        const embed = statusEmbed('Repeat Updated', `Repeat mode set to **${loop}**.`, player, SUCCESS_COLOR);
        return ctx.reply(playerPayload(embed, `Repeat set to ${loop}.`, player));
      }
    },
    {
      name: 'shuffle',
      description: 'Shuffle upcoming tracks.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        try {
          await shufflePlayer(player);
          const embed = statusEmbed('Queue Shuffled', `Shuffled ${queuedTracks(player).length} upcoming tracks.`, player, SUCCESS_COLOR);
          return ctx.reply(playerPayload(embed, 'Queue shuffled.', player));
        } catch (error) {
          const embed = statusEmbed('Shuffle Unavailable', error.message, player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, error.message));
        }
      }
    },
    {
      name: 'filters',
      aliases: ['filter'],
      description: 'Apply a music filter preset.',
      options: [
        {
          name: 'preset',
          description: 'Filter preset',
          type: 'string',
          required: true,
          choices: Object.keys(DEFAULT_FILTER_PRESETS).map((preset) => ({
            name: filterDisplayName(preset),
            value: preset
          }))
        }
      ],
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        const presetName = String(ctx.options?.preset || ctx.args?.[0] || '').toLowerCase();
        const presets = getFilterPresets(ctx);
        const preset = presets[presetName];
        if (!preset) {
          const embed = statusEmbed('Unknown Filter', 'Choose a valid filter preset.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Unknown filter preset.'));
        }

        const result = await applyFilterPreset(player, presetName, preset);
        if (!result.applied) {
          const embed = statusEmbed('Filters Unsupported', 'This Rainlink build or Lavalink node does not expose filter controls.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Filters are not supported here.'));
        }

        const label = presetName === 'reset' || result.reset ? 'reset' : filterDisplayName(presetName);
        const embed = statusEmbed('Filter Updated', `Applied filter preset **${escapeMarkdown(label)}**.`, player, SUCCESS_COLOR);
        return ctx.reply(playerPayload(embed, `Applied filter preset: ${label}.`, player));
      }
    },
    {
      name: 'playlist',
      description: 'Manage your saved music playlists.',
      options: [
        {
          name: 'action',
          description: 'Playlist action',
          type: 'string',
          required: true,
          choices: [
            { name: 'Create', value: 'create' },
            { name: 'List', value: 'list' },
            { name: 'Delete', value: 'delete' },
            { name: 'Save Current', value: 'save' },
            { name: 'Load', value: 'load' },
            { name: 'Import', value: 'import' },
            { name: 'Show', value: 'show' }
          ]
        },
        {
          name: 'name',
          description: 'Playlist name',
          type: 'string',
          required: false
        },
        {
          name: 'query',
          description: 'Playlist URL or search query for import',
          type: 'string',
          required: false
        }
      ],
      async execute(ctx) {
        try {
          if (!ctx.guildId) return ctx.reply(embedPayload(statusEmbed('Guild Only', 'Playlist commands must be used in a guild.', null, ERROR_COLOR), 'Guild only.'));
          assertDatabaseReady();

          const action = String(ctx.options?.action || ctx.args?.[0] || 'list').toLowerCase();
          let name = ctx.options?.name || ctx.args?.[1] || DEFAULT_PLAYLIST_NAME;
          let query = ctx.options?.query || ctx.args?.slice(2).join(' ') || '';
          if (action === 'import' && !ctx.options?.query) {
            query = ctx.args?.slice(1).join(' ') || query || name;
            name = ctx.options?.name || null;
          }

          if (action === 'list') {
            const playlists = await userPlaylists(ctx);
            if (!playlists.length) {
              const embed = statusEmbed('Your Playlists', 'No saved playlists yet.', null, INFO_COLOR);
              return ctx.reply(embedPayload(embed, 'No saved playlists yet.'));
            }

            const rows = [];
            for (const playlist of playlists) {
              const count = await PlaylistTrack.count({ where: { playlistId: playlist.id } });
              rows.push({ title: `${playlist.name} (${count} tracks)`, duration: 0 });
            }
            return ctx.reply(embedPayload(playlistEmbed('Your Playlists', 'Use `/playlist load` to queue one.', rows), 'Your playlists.'));
          }

          if (action === 'create') {
            const playlist = await ensurePlaylist(ctx, name);
            const embed = statusEmbed('Playlist Ready', `Playlist **${escapeMarkdown(playlist.name)}** is ready.`, null, SUCCESS_COLOR);
            return ctx.reply(embedPayload(embed, `Playlist ${playlist.name} is ready.`));
          }

          if (action === 'delete') {
            const playlist = await getPlaylist(ctx, name);
            if (!playlist) return ctx.reply(embedPayload(statusEmbed('Playlist Not Found', `No playlist named **${escapeMarkdown(name)}**.`, null, WARNING_COLOR), 'Playlist not found.'));
            await playlist.destroy();
            const embed = statusEmbed('Playlist Deleted', `Deleted **${escapeMarkdown(name)}**.`, null, SUCCESS_COLOR);
            return ctx.reply(embedPayload(embed, `Deleted ${name}.`));
          }

          if (action === 'save') {
            const player = getPlayer(ctx);
            const track = currentTrack(player);
            if (!track) return ctx.reply(embedPayload(statusEmbed('Nothing Playing', 'There is no current track to save.', player, WARNING_COLOR), 'Nothing playing.'));
            const playlist = await ensurePlaylist(ctx, name);
            await addTrackToPlaylist(playlist, track);
            const embed = statusEmbed('Saved Track', `Saved ${trackLine(track)} to **${escapeMarkdown(playlist.name)}**.`, player, SUCCESS_COLOR);
            return ctx.reply(playerPayload(embed, `Saved to ${playlist.name}.`, player));
          }

          if (action === 'show') {
            const playlist = await getPlaylist(ctx, name);
            if (!playlist) return ctx.reply(embedPayload(statusEmbed('Playlist Not Found', `No playlist named **${escapeMarkdown(name)}**.`, null, WARNING_COLOR), 'Playlist not found.'));
            const rows = await playlistTracks(playlist);
            return ctx.reply(embedPayload(playlistEmbed(`Playlist: ${playlist.name}`, `${rows.length} saved tracks.`, rows), `Playlist ${playlist.name}.`));
          }

          if (action === 'load') {
            const playlist = await getPlaylist(ctx, name);
            if (!playlist) return ctx.reply(embedPayload(statusEmbed('Playlist Not Found', `No playlist named **${escapeMarkdown(name)}**.`, null, WARNING_COLOR), 'Playlist not found.'));

            const voiceChannel = voiceChannelFor(ctx);
            if (!voiceChannel) return ctx.reply(embedPayload(statusEmbed('Voice Channel Required', 'Join a voice channel first.', null, WARNING_COLOR), 'Join a voice channel first.'));

            const rows = await playlistTracks(playlist);
            if (!rows.length) return ctx.reply(embedPayload(statusEmbed('Playlist Empty', `**${escapeMarkdown(playlist.name)}** has no tracks.`, null, WARNING_COLOR), 'Playlist is empty.'));

            const player = await getOrCreatePlayer(ctx, voiceChannel, ctx.message?.channel?.id || ctx.interaction?.channel?.id);
            const tracks = await playlistRecordsToTracks(rows, ctx.user);
            if (!tracks.length) return ctx.reply(embedPayload(statusEmbed('Load Failed', 'No saved tracks could be resolved.', player, ERROR_COLOR), 'No saved tracks could be resolved.'));

            player.queue.add(tracks);
            await safePlay(player);
            const embed = statusEmbed('Playlist Loaded', `Queued **${tracks.length}** tracks from **${escapeMarkdown(playlist.name)}**.`, player, SUCCESS_COLOR);
            return ctx.reply(playerPayload(embed, `Loaded ${playlist.name}.`, player));
          }

          if (action === 'import') {
            if (!query) return ctx.reply(embedPayload(statusEmbed('Missing Query', 'Provide a YouTube playlist URL or query.', null, WARNING_COLOR), 'Provide a playlist URL or query.'));
            const result = await searchTracks(ctx, query);
            if (!isPlaylistResult(result)) {
              return ctx.reply(embedPayload(statusEmbed('Not A Playlist', 'The import query did not return a playlist.', null, WARNING_COLOR), 'The query did not return a playlist.'));
            }

            const playlist = await ensurePlaylist(ctx, name || result.playlistName || DEFAULT_PLAYLIST_NAME, result.playlistName || null);
            await replacePlaylistTracks(playlist, result.tracks);
            const embed = playlistQueuedEmbed(result, result.tracks, { volume: 0, loop: 'none' });
            if (embed) embed.setTitle('Imported Playlist').setDescription(`Saved as **${escapeMarkdown(playlist.name)}**.`);
            return ctx.reply(embedPayload(embed, `Imported ${result.tracks.length} tracks as ${playlist.name}.`));
          }

          return ctx.reply(embedPayload(statusEmbed('Unknown Action', 'Use create, list, delete, save, load, import, or show.', null, WARNING_COLOR), 'Unknown playlist action.'));
        } catch (error) {
          ctx.logger.error('playlist command failed', { error: errorText(error) });
          const embed = statusEmbed('Playlist Error', error?.message || 'Unknown error', null, ERROR_COLOR);
          return ctx.reply(embedPayload(embed, error?.message || 'Playlist error.'));
        }
      }
    },
    {
      name: 'volume',
      description: 'Set volume from 0 to 150.',
      options: [
        {
          name: 'value',
          description: 'Volume percent',
          type: 'number',
          required: true
        }
      ],
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        const value = Math.max(0, Math.min(150, Number(ctx.options?.value ?? ctx.args?.[0])));
        if (!Number.isFinite(value)) {
          const embed = statusEmbed('Invalid Volume', 'Provide a volume from 0 to 150.', player, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Provide a volume from 0 to 150.'));
        }
        await player.setVolume(value);
        const embed = statusEmbed('Volume Updated', `Volume set to **${value}%**.`, player, SUCCESS_COLOR);
        return ctx.reply(embedPayload(embed, `Volume set to ${value}%.`));
      }
    },
    {
      name: 'autoplay',
      description: 'Toggle autoplay mode.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) {
          const embed = statusEmbed('Nothing Playing', 'There is no active player for this guild.', null, WARNING_COLOR);
          return ctx.reply(embedPayload(embed, 'Nothing playing.'));
        }

        if (typeof player.setAutoplay === 'function') {
          const nextValue = !Boolean(player.autoplay);
          await player.setAutoplay(nextValue);
          const embed = statusEmbed('Autoplay Updated', `Autoplay **${nextValue ? 'enabled' : 'disabled'}**.`, player, SUCCESS_COLOR);
          return ctx.reply(embedPayload(embed, `Autoplay ${nextValue ? 'enabled' : 'disabled'}.`));
        }

        if ('autoplay' in player) {
          player.autoplay = !Boolean(player.autoplay);
          const embed = statusEmbed('Autoplay Updated', `Autoplay **${player.autoplay ? 'enabled' : 'disabled'}**.`, player, SUCCESS_COLOR);
          return ctx.reply(embedPayload(embed, `Autoplay ${player.autoplay ? 'enabled' : 'disabled'}.`));
        }

        const embed = statusEmbed('Autoplay Unsupported', 'Autoplay is not supported by this Rainlink build.', player, WARNING_COLOR);
        return ctx.reply(embedPayload(embed, 'Autoplay is not supported by this Rainlink build.'));
      }
    }
  ]
};
