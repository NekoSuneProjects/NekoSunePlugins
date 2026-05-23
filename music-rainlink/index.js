let runtimeContext = null;
let Rainlink = null;
let Library = null;
let rainlink = null;

let configuredNodes = [];
let activeNodeIndex = 0;

const playerTextChannels = new Map();

/* =========================
   CONFIG SAFE ACCESS
========================= */

function getConfig(ctx, key, fallback) {
  try {
    if (typeof ctx?.getConfig === 'function') {
      const v = ctx.getConfig(key);
      if (v !== undefined) return v;
    }

    if (ctx?.config?.[key] !== undefined) return ctx.config[key];
    return fallback;
  } catch {
    return fallback;
  }
}

/* =========================
   NODES FIX (MAIN CRASH FIX)
========================= */

function getNodes(ctx) {
  const nodes = getConfig(ctx, 'lavalinkNodes', []);

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('[music-rainlink] lavalinkNodes missing or empty in config');
  }

  return nodes.map((node, i) => ({
    name: node.name || `node-${i + 1}`,
    host: node.host,
    port: Number(node.port || 2333),

    // 🔥 FIX: support both formats
    password: node.auth || node.password,

    secure: Boolean(node.secure),
    driver: node.driver
  }));
}

function rotateNodes(nodes, index = 0) {
  const safeIndex = ((index % nodes.length) + nodes.length) % nodes.length;
  return [...nodes.slice(safeIndex), ...nodes.slice(0, safeIndex)];
}

/* =========================
   UTILITIES
========================= */

function voiceChannelFor(ctx) {
  const member =
    ctx.guild?.members?.cache?.get?.(ctx.user?.id) ||
    ctx.member;

  return member?.voice?.channel || null;
}

function queryText(ctx) {
  return (ctx.options?.query || ctx.args?.join(' ') || '').trim();
}

function queueLength(player) {
  if (!player?.queue) return 0;
  if (Array.isArray(player.queue)) return player.queue.length;
  if (Array.isArray(player.queue.tracks)) return player.queue.tracks.length;
  if (typeof player.queue.size === 'number') return player.queue.size;
  return 0;
}

function normalizeResult(result) {
  const loadType =
    result.loadType ||
    result.type ||
    (result.playlistInfo ? 'PLAYLIST_LOADED' : 'TRACK_LOADED');

  return { ...result, loadType };
}

/* =========================
   ANNOUNCE SAFE
========================= */

async function announce(player, message) {
  const channelId =
    playerTextChannels.get(player.guildId || player.guildID);

  if (!channelId || !runtimeContext?.client?.channels?.fetch) return;

  try {
    const channel = await runtimeContext.client.channels.fetch(channelId);
    if (channel?.send) await channel.send({ content: message });
  } catch {}
}

/* =========================
   RAINLINK SETUP (FIXED)
========================= */

async function setupRainlink(ctx, startIndex = 0) {
  if (!configuredNodes.length) {
    configuredNodes = getNodes(ctx);
  }

  activeNodeIndex = startIndex;

  try {
    if (rainlink?.destroy) await rainlink.destroy();
  } catch {}

  rainlink = new Rainlink({
    library: new Library.DiscordJS(ctx.client),
    nodes: rotateNodes(configuredNodes, activeNodeIndex)
  });

  rainlink.on('nodeError', (node, err) => {
    ctx.logger.error('Lavalink node error', { node: node?.name, err });
  });

  rainlink.on('trackStart', (player, track) => {
    if (getConfig(ctx, 'announceNowPlaying', true)) {
      announce(player, `▶️ Now playing: **${track.title}**`);
    }
  });

  rainlink.on('queueEmpty', async (player) => {
    if (getConfig(ctx, 'leaveOnQueueEnd', true)) {
      try {
        await player.destroy();
      } catch {}
    }
  });

  if (typeof rainlink.connect === 'function') {
    await rainlink.connect();
  }

  ctx.logger.info(
    `music-rainlink active node: ${configuredNodes[activeNodeIndex]?.name}`
  );
}

/* =========================
   PLAYER
========================= */

async function getOrCreatePlayer(ctx, voiceChannel, textChannelId) {
  if (!voiceChannel) throw new Error('No voice channel');

  let player = rainlink.players.get(ctx.guildId);

  if (!player) {
    player = await rainlink.create({
      guildId: ctx.guildId,
      textId: textChannelId,
      voiceId: voiceChannel.id,
      volume: Math.round(getConfig(ctx, 'volume', 0.65) * 100)
    });
  } else if (player.voiceId !== voiceChannel.id) {
    await player.connect(voiceChannel.id);
  }

  playerTextChannels.set(ctx.guildId, textChannelId);
  return player;
}

/* =========================
   SEARCH
========================= */

async function searchTracks(ctx, query) {
  const result = await rainlink.search(query, {
    requester: ctx.user,
    source: getConfig(ctx, 'defaultSearchPlatform', 'ytsearch')
  });

  if (!result?.tracks?.length) {
    throw new Error('No tracks found.');
  }

  return normalizeResult(result);
}

/* =========================
   SAFE PLAY
========================= */

async function safePlay(player) {
  try {
    if (!player) return;
    if (player.playing || player.paused) return;
    if (!queueLength(player)) return;

    await player.play().catch(() => {});
  } catch {}
}

/* =========================
   MODULE EXPORT
========================= */

module.exports = {
  defaultConfig: {
    maxQueueSize: 50,
    volume: 0.65,
    leaveOnQueueEnd: true,
    defaultSearchPlatform: 'ytsearch',
    lavalinkNodes: []
  },

  async load(ctx) {
    runtimeContext = ctx;
    ({ Rainlink, Library } = require('rainlink'));

    configuredNodes = getNodes(ctx);

    await setupRainlink(ctx, 0);

    ctx.logger.info('music-rainlink loaded successfully');
  },

  async unload() {
    try {
      if (rainlink?.destroy) await rainlink.destroy();
    } catch {}

    playerTextChannels.clear();
  },

  commands: [
    {
      name: 'play',
      description: 'Play music',
      options: [{ name: 'query', type: 'string', required: true }],

      async execute(ctx) {
        try {
          if (!ctx.guildId) return ctx.reply('Guild only.');

          const voiceChannel = voiceChannelFor(ctx);
          if (!voiceChannel) return ctx.reply('Join a voice channel.');

          const query = queryText(ctx);
          if (!query) return ctx.reply('No query.');

          const textChannelId =
            ctx.message?.channel?.id ||
            ctx.interaction?.channel?.id;

          const player = await getOrCreatePlayer(
            ctx,
            voiceChannel,
            textChannelId
          );

          const maxQueue = getConfig(ctx, 'maxQueueSize', 50);

          if (queueLength(player) >= maxQueue) {
            return ctx.reply('Queue full.');
          }

          const result = await searchTracks(ctx, query);

          if (result.loadType === 'PLAYLIST_LOADED') {
            const add = result.tracks.slice(
              0,
              maxQueue - queueLength(player)
            );

            add.forEach(t => player.queue.add(t));
            await safePlay(player);

            return ctx.reply(`Queued playlist (${add.length})`);
          }

          const track = result.tracks[0];
          player.queue.add(track);

          await safePlay(player);

          return ctx.reply(`Queued: ${track.title}`);
        } catch (err) {
          ctx.logger.error(err);
          return ctx.reply(`Error: ${err.message}`);
        }
      }
    },

    {
      name: 'pause',
      async execute(ctx) {
        const p = rainlink.players.get(ctx.guildId);
        if (!p) return ctx.reply('Nothing playing.');
        await p.pause(true);
        return ctx.reply('Paused.');
      }
    },

    {
      name: 'resume',
      async execute(ctx) {
        const p = rainlink.players.get(ctx.guildId);
        if (!p) return ctx.reply('Nothing playing.');
        await p.pause(false);
        return ctx.reply('Resumed.');
      }
    },

    {
      name: 'skip',
      async execute(ctx) {
        const p = rainlink.players.get(ctx.guildId);
        if (!p) return ctx.reply('Nothing playing.');
        await p.stop();
        return ctx.reply('Skipped.');
      }
    },

    {
      name: 'stop',
      async execute(ctx) {
        const p = rainlink.players.get(ctx.guildId);
        if (!p) return ctx.reply('Nothing playing.');

        try {
          if (p.queue?.clear) p.queue.clear();
          await p.stop();
          await p.destroy();
        } catch {}

        return ctx.reply('Stopped.');
      }
    }
  ]
};