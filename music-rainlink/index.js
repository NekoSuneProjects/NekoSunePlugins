let runtimeContext = null;
let Rainlink = null;
let Library = null;
let rainlink = null;

const playerTextChannels = new Map();

function getConfig(ctx, key, fallback) {
  return ctx.configManager.getPluginConfig('music-rainlink', key, fallback);
}

function getNodes(ctx) {
  const nodes = getConfig(ctx, 'lavalinkNodes', []);
  if (!Array.isArray(nodes) || !nodes.length) {
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

function queryText(ctx) {
  return (ctx.options.query || ctx.args.join(' ') || '').trim();
}

function voiceChannelFor(ctx) {
  const cachedMember = ctx.guild?.members?.cache?.get?.(ctx.user?.id);
  return cachedMember?.voice?.channel || ctx.member?.voice?.channel || null;
}

function queueLength(player) {
  if (!player?.queue) return 0;
  if (Array.isArray(player.queue)) return player.queue.length;
  if (typeof player.queue.size === 'number') return player.queue.size;
  if (Array.isArray(player.queue.tracks)) return player.queue.tracks.length;
  return 0;
}

async function announce(player, message) {
  const channelId = playerTextChannels.get(player.guildId || player.guildID || player.guild);
  if (!channelId || !runtimeContext?.client?.channels?.fetch) return;
  try {
    const channel = await runtimeContext.client.channels.fetch(channelId);
    if (channel?.send) await channel.send(message);
  } catch (error) {
    runtimeContext.logger.warn('Failed to announce message', { message, error });
  }
}

async function getOrCreatePlayer(ctx, voiceChannel, textChannelId) {
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
    await player.connect(voiceChannel.id);
  }

  if (typeof player.setAutoplay === 'function') {
    await player.setAutoplay(Boolean(getConfig(ctx, 'autoplay', true)));
  } else if ('autoplay' in player) {
    player.autoplay = Boolean(getConfig(ctx, 'autoplay', true));
  }

  playerTextChannels.set(ctx.guildId, textChannelId);
  return player;
}

async function searchTracks(ctx, query) {
  const defaultPlatform = getConfig(ctx, 'defaultSearchPlatform', 'ytsearch');
  const result = await rainlink.search(query, {
    requester: ctx.user,
    source: defaultPlatform
  });

  if (!result?.tracks?.length) {
    throw new Error('No tracks found for your query.');
  }

  return result;
}

module.exports = {
  defaultConfig: {
    maxQueueSize: 50,
    volume: 0.65,
    leaveOnStop: true,
    leaveOnQueueEnd: true,
    autoplay: true,
    announceNowPlaying: true,
    announceTrackAdd: true,
    announceTrackEnd: false,
    announceQueueEnd: true,
    defaultSearchPlatform: 'ytsearch',
    lavalinkNodes: []
  },

  async load(ctx) {
    runtimeContext = ctx;
    ({ Rainlink, Library } = require('rainlink'));

    rainlink = new Rainlink({
      library: new Library.DiscordJS(ctx.client),
      nodes: getNodes(ctx)
    });

    rainlink.on('nodeConnect', (node) => ctx.logger.info(`Lavalink node connected: ${node.options?.name || node.name}`));
    rainlink.on('nodeError', (node, error) => ctx.logger.error('Lavalink node error', { node: node.options?.name || node.name, error }));
    rainlink.on('trackStart', (player, track) => {
      if (getConfig(ctx, 'announceNowPlaying', true)) {
        announce(player, `▶️ Now playing: **${track.title}**`);
      }
    });
    rainlink.on('trackEnd', (player, track) => {
      if (getConfig(ctx, 'announceTrackEnd', false)) {
        announce(player, `✅ Finished: **${track?.title || 'Track'}**`);
      }

      const next = player?.queue?.[0] || player?.queue?.tracks?.[0];
      if (next) announce(player, `⏭️ Up next: **${next.title}**`);
    });
    rainlink.on('queueEmpty', async (player) => {
      if (getConfig(ctx, 'announceQueueEnd', true)) {
        await announce(player, '📭 Queue ended.');
      }
      if (getConfig(ctx, 'leaveOnQueueEnd', true) && typeof player.destroy === 'function') {
        await player.destroy();
      }
    });

    if (typeof rainlink.connect === 'function') await rainlink.connect();
    ctx.logger.info('music-rainlink loaded');
  },

  async unload() {
    if (!rainlink) return;
    for (const [, player] of rainlink.players) {
      if (typeof player.destroy === 'function') await player.destroy();
    }
    if (typeof rainlink.destroy === 'function') await rainlink.destroy();
    playerTextChannels.clear();
  },

  commands: [
    {
      name: 'play',
      description: 'Play tracks via Lavalink (supports v3/v4 nodes).',
      cooldownMs: 1500,
      options: [{ name: 'query', description: 'Song name, URL, or playlist', type: 'string', required: true }],
      async execute(ctx) {
        if (!ctx.guildId) return ctx.reply('Music commands must be used in a guild.');
        const voiceChannel = voiceChannelFor(ctx);
        if (!voiceChannel) return ctx.reply('Join a voice channel first.');

        const query = queryText(ctx);
        if (!query) return ctx.reply('Provide a query or URL.');

        const textChannelId = ctx.message?.channel?.id || ctx.interaction?.channel?.id;
        const player = await getOrCreatePlayer(ctx, voiceChannel, textChannelId);
        const maxQueueSize = Number(getConfig(ctx, 'maxQueueSize', 50));
        if (queueLength(player) >= maxQueueSize) return ctx.reply(`Queue limit reached (${maxQueueSize}).`);

        const result = await searchTracks(ctx, query);
        if (result.type === 'PLAYLIST') {
          for (const track of result.tracks.slice(0, maxQueueSize - queueLength(player))) {
            player.queue.add(track);
          }
          if (!player.playing && !player.paused) await player.play();
          return ctx.reply(`Queued playlist: **${result.playlistName || 'Playlist'}** (${result.tracks.length} tracks).`);
        }

        player.queue.add(result.tracks[0]);
        if (getConfig(ctx, 'announceTrackAdd', true)) await ctx.reply(`Queued: **${result.tracks[0].title}**`);
        if (!player.playing && !player.paused) await player.play();
        return null;
      }
    },
    { name: 'pause', description: 'Pause playback.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p || p.paused) return ctx.reply('Nothing to pause.'); await p.pause(true); return ctx.reply('⏸️ Paused.'); } },
    { name: 'resume', aliases: ['unpause'], description: 'Resume playback.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p || !p.paused) return ctx.reply('Nothing paused.'); await p.pause(false); return ctx.reply('▶️ Resumed.'); } },
    { name: 'skip', description: 'Skip current track.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p) return ctx.reply('Nothing playing.'); await p.stop(); return ctx.reply('⏭️ Skipped.'); } },
    { name: 'stop', description: 'Stop playback and clear queue.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p) return ctx.reply('Nothing playing.'); if (typeof p.queue?.clear === 'function') p.queue.clear(); else if (Array.isArray(p.queue)) p.queue.length = 0; await p.stop(); if (getConfig(ctx, 'leaveOnStop', true)) await p.destroy(); return ctx.reply('⏹️ Stopped and queue cleared.'); } },
    { name: 'queue', description: 'Show queue.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p) return ctx.reply('Queue is empty.'); const current = p.current || p.nowPlaying; const tracks = p.queue?.tracks || p.queue || []; if (!current && !tracks.length) return ctx.reply('Queue is empty.'); const lines = []; if (current) lines.push(`Now: **${current.title}**`); tracks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title}`)); if (tracks.length > 10) lines.push(`...and ${tracks.length - 10} more`); return ctx.reply(lines.join('\n')); } },
    { name: 'volume', description: 'Set volume (0-150).', options: [{ name: 'value', description: 'Volume percent', type: 'number', required: true }], async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p) return ctx.reply('Nothing playing.'); const value = Math.max(0, Math.min(150, Number(ctx.options.value || ctx.args[0]))); await p.setVolume(value); return ctx.reply(`🔊 Volume set to ${value}%`); } },
    { name: 'autoplay', description: 'Toggle autoplay mode.', async execute(ctx) { const p = rainlink.players.get(ctx.guildId); if (!p) return ctx.reply('Nothing playing.'); if (typeof p.setAutoplay === 'function') { const nextValue = !Boolean(p.autoplay); await p.setAutoplay(nextValue); return ctx.reply(`Autoplay ${nextValue ? 'enabled' : 'disabled'}.`); } if ('autoplay' in p) { p.autoplay = !Boolean(p.autoplay); return ctx.reply(`Autoplay ${p.autoplay ? 'enabled' : 'disabled'}.`); } return ctx.reply('Autoplay is not supported by this Rainlink build.'); } }
  ]
};
