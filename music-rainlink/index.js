let runtimeContext = null;
let Rainlink = null;
let Library = null;
let rainlink = null;
let rainlinkRawClient = null;

let configuredNodes = [];
let activeNodeIndex = 0;
let failoverInProgress = false;

const rainlinkClientListeners = [];
const rainlinkClientImmediates = [];
const playerTextChannels = new Map();

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

async function announce(player, message) {
  const channelId = playerTextChannels.get(player.guildId || player.guildID || player.guild);
  const client = runtimeContext?.rawClient || runtimeContext?.client;
  if (!channelId || !client?.channels?.fetch) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.send) await channel.send({ content: message });
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
      void announce(player, `Now playing: **${track?.title || 'Unknown track'}**`);
    }
  });

  rainlink.on('trackEnd', (player, track) => {
    if (getConfig(ctx, 'announceTrackEnd', false)) {
      void announce(player, `Finished: **${track?.title || 'Track'}**`);
    }
  });

  rainlink.on('queueEmpty', async (player) => {
    if (getConfig(ctx, 'announceQueueEnd', true)) {
      await announce(player, 'Queue ended.');
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

module.exports = {
  defaultConfig: DEFAULT_CONFIG,

  async load(ctx) {
    runtimeContext = ctx;
    ({ Rainlink, Library } = require('rainlink'));

    warnIfVoiceIntentMissing(ctx);
    configuredNodes = getNodes(ctx);
    await setupRainlink(ctx, 0);
    ctx.logger.info('music-rainlink loaded successfully');
  },

  async unload() {
    await teardownRainlink(runtimeContext, { clearTextChannels: true });
    runtimeContext = null;
  },

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
          if (!ctx.guildId) return ctx.reply('Music commands must be used in a guild.');

          const voiceChannel = voiceChannelFor(ctx);
          if (!voiceChannel) return ctx.reply('Join a voice channel first.');

          const query = queryText(ctx);
          if (!query) return ctx.reply('Provide a song name, URL, or playlist.');

          const textChannelId = ctx.message?.channel?.id || ctx.interaction?.channel?.id;
          const player = await getOrCreatePlayer(ctx, voiceChannel, textChannelId);
          const maxQueueSize = Number(getConfig(ctx, 'maxQueueSize', 50));

          if (queueLength(player) >= maxQueueSize) {
            return ctx.reply(`Queue limit reached (${maxQueueSize}).`);
          }

          const result = await searchTracks(ctx, query);
          if (isPlaylistResult(result)) {
            const available = Math.max(0, maxQueueSize - queueLength(player));
            const tracks = result.tracks.slice(0, available);
            player.queue.add(tracks);
            await safePlay(player);

            if (getConfig(ctx, 'announceTrackAdd', true)) {
              await announce(player, `Queued ${tracks.length} tracks from ${result.playlistName || 'playlist'}.`);
            }

            return ctx.reply(`Queued ${tracks.length} tracks from ${result.playlistName || 'playlist'}.`);
          }

          const track = result.tracks[0];
          player.queue.add(track);
          await safePlay(player);

          if (getConfig(ctx, 'announceTrackAdd', true)) {
            await announce(player, `Queued: **${track.title || 'Unknown track'}**`);
          }

          return ctx.reply(`Queued: ${track.title || 'Unknown track'}`);
        } catch (error) {
          ctx.logger.error('play command failed', { error: errorText(error) });
          return ctx.reply(`Could not play track: ${error?.message || 'Unknown error'}`);
        }
      }
    },
    {
      name: 'pause',
      description: 'Pause playback.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player || player.paused || !player.playing) return ctx.reply('Nothing to pause.');
        await pausePlayer(player);
        return ctx.reply('Paused.');
      }
    },
    {
      name: 'resume',
      aliases: ['unpause'],
      description: 'Resume playback.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player || !player.paused) return ctx.reply('Nothing paused.');
        await resumePlayer(player);
        return ctx.reply('Resumed.');
      }
    },
    {
      name: 'skip',
      description: 'Skip current track.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player || !currentTrack(player)) return ctx.reply('Nothing playing.');
        if (typeof player.skip === 'function') await player.skip();
        else if (typeof player.stop === 'function') await player.stop(false);
        await safePlay(player);
        return ctx.reply('Skipped.');
      }
    },
    {
      name: 'stop',
      description: 'Stop playback and clear the queue.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) return ctx.reply('Nothing playing.');

        if (typeof player.queue?.clear === 'function') player.queue.clear();
        else if (Array.isArray(player.queue)) player.queue.length = 0;

        if (typeof player.stop === 'function') await player.stop(false).catch(() => {});
        if (getConfig(ctx, 'leaveOnStop', true) && typeof player.destroy === 'function') {
          await player.destroy();
        }

        return ctx.reply('Stopped and queue cleared.');
      }
    },
    {
      name: 'queue',
      description: 'Show the current queue.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) return ctx.reply('Queue is empty.');

        const current = currentTrack(player);
        const tracks = queuedTracks(player);
        if (!current && tracks.length === 0) return ctx.reply('Queue is empty.');

        const lines = [];
        if (current) lines.push(`Now: **${current.title || 'Unknown track'}**`);
        tracks.slice(0, 10).forEach((track, index) => {
          lines.push(`${index + 1}. ${track.title || 'Unknown track'}`);
        });
        if (tracks.length > 10) lines.push(`...and ${tracks.length - 10} more`);
        return ctx.reply(lines.join('\n'));
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
        if (!player) return ctx.reply('Nothing playing.');

        const value = Math.max(0, Math.min(150, Number(ctx.options?.value ?? ctx.args?.[0])));
        if (!Number.isFinite(value)) return ctx.reply('Provide a volume from 0 to 150.');
        await player.setVolume(value);
        return ctx.reply(`Volume set to ${value}%.`);
      }
    },
    {
      name: 'autoplay',
      description: 'Toggle autoplay mode.',
      async execute(ctx) {
        const player = getPlayer(ctx);
        if (!player) return ctx.reply('Nothing playing.');

        if (typeof player.setAutoplay === 'function') {
          const nextValue = !Boolean(player.autoplay);
          await player.setAutoplay(nextValue);
          return ctx.reply(`Autoplay ${nextValue ? 'enabled' : 'disabled'}.`);
        }

        if ('autoplay' in player) {
          player.autoplay = !Boolean(player.autoplay);
          return ctx.reply(`Autoplay ${player.autoplay ? 'enabled' : 'disabled'}.`);
        }

        return ctx.reply('Autoplay is not supported by this Rainlink build.');
      }
    }
  ]
};
