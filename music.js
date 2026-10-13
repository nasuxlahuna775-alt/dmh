import { Readable } from 'node:stream';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Innertube } from 'youtubei.js';

const queues = new Map();
let youtubeClientPromise;
const MAX_QUEUE_SIZE = 30;
const YOUTUBE_PLAYER_CLIENTS = ['WEB', 'ANDROID', 'TV_EMBEDDED', 'IOS'];
const AUDIO_FORMAT_OPTIONS = { type: 'audio', quality: 'best', format: 'webm', codec: 'opus' };

function parseYoutubeVideoId(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return null;

  let videoId = url.searchParams.get('v');
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0];
  if (!videoId && ['shorts', 'live', 'embed'].includes(url.pathname.split('/').filter(Boolean)[0])) {
    videoId = url.pathname.split('/').filter(Boolean)[1];
  }
  return /^[\w-]{11}$/.test(videoId ?? '') ? videoId : null;
}

async function getYoutubeClient() {
  youtubeClientPromise ??= Innertube.create({ generate_session_locally: true });
  return youtubeClientPromise;
}

async function downloadYoutubeAudio(videoId, isCancelled) {
  const youtube = await getYoutubeClient();
  const failures = [];

  for (const client of YOUTUBE_PLAYER_CLIENTS) {
    if (isCancelled()) return null;
    try {
      const info = await youtube.getBasicInfo(videoId, { client });
      if (isCancelled()) return null;
      const formats = [
        ...(info.streaming_data?.formats ?? []),
        ...(info.streaming_data?.adaptive_formats ?? []),
      ]
        .filter(format => format.has_audio
          && !format.has_video
          && format.mime_type?.toLowerCase().includes('webm')
          && format.mime_type?.toLowerCase().includes('opus')
          && (format.url || format.signature_cipher || format.cipher))
        .sort((a, b) => Number(Boolean(b.url)) - Number(Boolean(a.url)) || b.bitrate - a.bitrate);

      if (!formats.length) {
        failures.push(`${client}: ไม่มีสตรีมเสียง Opus ที่มี URL`);
        continue;
      }

      for (const format of formats) {
        if (isCancelled()) return null;
        try {
          const stream = await info.download({ ...AUDIO_FORMAT_OPTIONS, itag: format.itag });
          if (isCancelled()) {
            await stream.cancel().catch(() => {});
            return null;
          }
          return stream;
        } catch (error) {
          failures.push(`${client}/${format.itag}: ${error?.message ?? error}`);
        }
      }
    } catch (error) {
      failures.push(`${client}: ${error?.message ?? error}`);
    }
  }

  if (isCancelled()) return null;
  throw new Error(`หาไฟล์เสียง YouTube ที่ใช้เล่นไม่ได้: ${failures.slice(-8).join(' | ')}`);
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'ไม่ทราบความยาว';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function makeControls(paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:toggle').setLabel(paused ? 'เล่นต่อ' : 'พัก').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music:skip').setLabel('ข้าม').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:stop').setLabel('หยุด').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('music:volume-down').setLabel('เบา').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:volume-up').setLabel('ดัง').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
  );
}

function panelContent(state) {
  const currentStatus = state.current
    ? `${state.player.state.status === AudioPlayerStatus.Paused ? '⏸️ พักอยู่' : state.loading ? '⌛ กำลังโหลด' : '🔊 กำลังเล่น'}: **${state.current.title}** (${durationText(state.current.duration)})\n[เปิดใน YouTube](${state.current.url})`
    : state.lastError ? `⚠️ ${state.lastError}` : '⏹️ ตอนนี้ไม่มีเพลงกำลังเล่น';
  const upcoming = state.queue.length
    ? `\n\n**เพลงถัดไป**\n${state.queue.slice(0, 5).map((track, index) => `${index + 1}. ${track.title}`).join('\n')}${state.queue.length > 5 ? `\nและอีก ${state.queue.length - 5} เพลง` : ''}`
    : '';
  return `## 🎵 แผงควบคุมเพลง\n${currentStatus}\nเสียง: **${Math.round(state.volume * 100)}%**${upcoming}`;
}

async function syncPanel(state, channel) {
  const payload = { content: panelContent(state), components: [makeControls(state.player.state.status === AudioPlayerStatus.Paused)] };
  try {
    if (state.panelMessageId && state.panelChannelId) {
      const panelChannel = await channel.guild.channels.fetch(state.panelChannelId).catch(() => null);
      const existing = panelChannel?.isTextBased()
        ? await panelChannel.messages.fetch(state.panelMessageId).catch(() => null)
        : null;
      if (existing) {
        await existing.edit(payload);
        return existing;
      }
    }
    if (!channel?.isTextBased()) return null;
    const panel = await channel.send(payload);
    state.panelChannelId = channel.id;
    state.panelMessageId = panel.id;
    return panel;
  } catch (error) {
    console.error(`อัปเดตแผงเพลงไม่สำเร็จ: ${error?.message ?? error}`);
    return null;
  }
}

async function startNext(state) {
  if (state.stopped || state.loading || state.player.state.status !== AudioPlayerStatus.Idle) return;
  const track = state.queue.shift();
  if (!track) {
    state.current = null;
    await syncPanel(state, state.panelChannel);
    return;
  }

  state.current = track;
  state.loading = true;
  state.skipRequested = false;
  state.lastError = null;
  await syncPanel(state, state.panelChannel);
  try {
    const webStream = await downloadYoutubeAudio(track.videoId, () => state.stopped || state.skipRequested);
    if (!webStream) {
      state.loading = false;
      if (state.stopped) return;
      state.current = null;
      state.skipRequested = false;
      void startNext(state);
      return;
    }
    if (state.stopped) return;
    if (state.skipRequested) {
      await webStream.cancel().catch(() => {});
      state.loading = false;
      state.current = null;
      state.resource = null;
      state.skipRequested = false;
      void startNext(state);
      return;
    }
    const stream = Readable.fromWeb(webStream);
    const resource = createAudioResource(stream, { inputType: StreamType.WebmOpus, inlineVolume: true });
    resource.volume?.setVolume(state.volume);
    state.resource = resource;
    state.loading = false;
    state.lastError = null;
    state.player.play(resource);
    await syncPanel(state, state.panelChannel);
  } catch (error) {
    state.loading = false;
    state.current = null;
    if (state.stopped) return;
    console.error(`เล่นเพลง YouTube ไม่สำเร็จ: ${error?.message ?? error}`);
    state.lastError = 'เปิดเพลงนี้ไม่ได้ ลองใช้ลิงก์วิดีโอ YouTube ปกติอีกครั้ง';
    await syncPanel(state, state.panelChannel);
    if (state.queue.length) void startNext(state);
  }
}

function createGuildQueue(interaction, voiceChannelId) {
  const guildId = interaction.guildId;
  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);

  const state = {
    guildId,
    voiceChannelId,
    connection,
    player,
    queue: [],
    current: null,
    resource: null,
    volume: 0.5,
    panelChannel: interaction.channel,
    panelChannelId: null,
    panelMessageId: null,
    loading: false,
    skipRequested: false,
    lastError: null,
    stopped: false,
  };
  player.on(AudioPlayerStatus.Idle, () => {
    if (state.stopped) return;
    state.current = null;
    state.resource = null;
    void startNext(state);
  });
  player.on('error', error => {
    console.error(`เครื่องเล่นเพลงขัดข้อง: ${error.message}`);
    state.current = null;
    state.resource = null;
    state.loading = false;
    void startNext(state);
  });
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    state.stopped = true;
    queues.delete(guildId);
  });
  queues.set(guildId, state);
  return state;
}

export async function handleMusicCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'play') return false;
  if (!interaction.guild || !interaction.channel?.isTextBased()) {
    await interaction.reply({ content: 'คำสั่งนี้ใช้ในห้องข้อความของเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return true;
  }

  const query = interaction.options.getString('ลิงก์', true).trim();
  const videoId = parseYoutubeVideoId(query);
  if (!videoId) {
    await interaction.reply({ content: 'ส่งลิงก์วิดีโอ YouTube แบบ youtube.com/watch?v=... หรือ youtu.be/... นะครับ', flags: MessageFlags.Ephemeral });
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannelId = member?.voice?.channelId;
  if (!voiceChannelId) {
    await interaction.reply({ content: 'เข้าห้องเสียงก่อน แล้วค่อยใช้ /play ครับ', flags: MessageFlags.Ephemeral });
    return true;
  }

  const existing = queues.get(interaction.guildId);
  if (existing && existing.voiceChannelId !== voiceChannelId) {
    await interaction.reply({ content: 'บอทกำลังเล่นเพลงในห้องเสียงอื่นอยู่ครับ', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (existing && existing.queue.length + (existing.current ? 1 : 0) >= MAX_QUEUE_SIZE) {
    await interaction.reply({ content: `คิวเต็มแล้ว จำกัดไม่เกิน ${MAX_QUEUE_SIZE} เพลง`, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const youtube = await getYoutubeClient();
    const info = await youtube.getBasicInfo(videoId);
    const details = info.basic_info;
    if (!details?.title || details.is_live) {
      await interaction.editReply('ตอนนี้รับเฉพาะวิดีโอ YouTube ปกติ ยังไม่รองรับไลฟ์สดครับ');
      return true;
    }
    const track = {
      videoId,
      title: details.title,
      duration: Number(details.duration) || 0,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      requestedBy: interaction.user.id,
    };
    let state = existing;
    if (!state) {
      state = createGuildQueue(interaction, voiceChannelId);
    try {
      await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      state.stopped = true;
      state.connection.destroy();
      queues.delete(interaction.guildId);
      throw error;
    }
    }
    state.panelChannel = interaction.channel;
    state.queue.push(track);
    await syncPanel(state, interaction.channel);
    await interaction.editReply(`เพิ่ม **${track.title}** เข้าคิวแล้ว`);
    if (!state.current && !state.loading && state.player.state.status === AudioPlayerStatus.Idle) void startNext(state);
  } catch (error) {
    console.error(`เพิ่มเพลงไม่สำเร็จ: ${error?.message ?? error}`);
    await interaction.editReply('เปิดเพลงไม่ได้ ลองตรวจลิงก์ YouTube หรือเช็กสิทธิ์ Connect และ Speak ของบอท');
  }
  return true;
}

export async function handleMusicInteraction(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('music:')) return false;
  const state = queues.get(interaction.guildId);
  if (!state) {
    await interaction.reply({ content: 'ตอนนี้ไม่มีเครื่องเล่นเพลงที่ทำงานอยู่', flags: MessageFlags.Ephemeral });
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.voice?.channelId || member.voice.channelId !== state.voiceChannelId) {
    await interaction.reply({ content: 'ต้องอยู่ห้องเสียงเดียวกับบอทเพื่อกดแผงควบคุม', flags: MessageFlags.Ephemeral });
    return true;
  }
  const canControl = member.permissions.has(PermissionFlagsBits.ManageMessages)
    || member.permissions.has(PermissionFlagsBits.Administrator)
    || state.current?.requestedBy === interaction.user.id
    || state.queue.some(track => track.requestedBy === interaction.user.id);
  if (!canControl) {
    await interaction.reply({ content: 'ใช้แผงควบคุมได้เฉพาะคนที่ขอเพลงหรือทีมงาน', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();
  if (interaction.customId === 'music:toggle') {
    if (state.player.state.status === AudioPlayerStatus.Paused) state.player.unpause();
    else if (state.player.state.status === AudioPlayerStatus.Playing) state.player.pause();
  } else if (interaction.customId === 'music:skip') {
    if (state.loading) state.skipRequested = true;
    else if (state.player.state.status !== AudioPlayerStatus.Idle) state.player.stop(true);
    else void startNext(state);
  } else if (interaction.customId === 'music:volume-down' || interaction.customId === 'music:volume-up') {
    const delta = interaction.customId === 'music:volume-up' ? 0.1 : -0.1;
    state.volume = Math.max(0.1, Math.min(1, Math.round((state.volume + delta) * 10) / 10));
    state.resource?.volume?.setVolume(state.volume);
  } else if (interaction.customId === 'music:stop') {
    state.stopped = true;
    state.queue.length = 0;
    state.player.stop(true);
    state.connection.destroy();
    queues.delete(interaction.guildId);
    await interaction.message.edit({ content: '⏹️ หยุดเพลงและออกจากห้องเสียงแล้ว', components: [] });
    return true;
  }
  await syncPanel(state, interaction.channel);
  return true;
}
