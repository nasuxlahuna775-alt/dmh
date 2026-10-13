import { readFile, writeFile } from 'node:fs/promises';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const STORE_PATH = new URL('./guild-settings.json', import.meta.url);
const SPAM_WINDOW_MS = 5_000;
const SPAM_MESSAGE_LIMIT = 7;
const DUPLICATE_WINDOW_MS = 10_000;
const DUPLICATE_MESSAGE_LIMIT = 5;
const spamWindows = new Map();
const banInProgress = new Set();

let store = { guilds: {}, warnings: {} };
let pendingWrite = Promise.resolve();

export async function loadServerFeatureStore() {
  try {
    const saved = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    store = {
      guilds: saved.guilds && typeof saved.guilds === 'object' ? saved.guilds : {},
      warnings: saved.warnings && typeof saved.warnings === 'object' ? saved.warnings : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function saveStore() {
  const snapshot = JSON.stringify(store, null, 2);
  pendingWrite = pendingWrite.then(() => writeFile(STORE_PATH, snapshot, 'utf8'));
  return pendingWrite;
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function safeName(value) {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 30) || 'member';
}

function ticketOpenButton(staffRoleId = '0') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket-open:${staffRoleId}`)
      .setLabel('แจ้งปัญหา')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );
}

function ticketCloseButton(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket-close')
      .setLabel('ปิดห้องแจ้งปัญหา')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

async function handleWelcomeSetup(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'คำสั่งนี้ให้แอดมินใช้เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.options.getChannel('ช่อง', true);
  if (!channel.isTextBased() || !channel.guild) {
    await interaction.reply({ content: 'เลือกห้องข้อความในเซิร์ฟเวอร์นะครับ', flags: MessageFlags.Ephemeral });
    return;
  }
  store.guilds[interaction.guildId] ??= {};
  store.guilds[interaction.guildId].welcomeChannelId = channel.id;
  await saveStore();
  await interaction.reply({ content: `ตั้งห้องต้อนรับสมาชิกเป็น ${channel} แล้ว`, flags: MessageFlags.Ephemeral });
}

async function handleTicketPanel(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'คำสั่งนี้ให้แอดมินใช้เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.channel?.isTextBased()) {
    await interaction.reply({ content: 'ใช้คำสั่งนี้ในห้องข้อความนะครับ', flags: MessageFlags.Ephemeral });
    return;
  }
  const staffRole = interaction.options.getRole('ทีมงาน');
  try {
    const panel = await interaction.channel.send({
      content: '## 🎫 แจ้งปัญหา\nกดปุ่มด้านล่าง แล้วอธิบายปัญหาเพื่อเปิดห้องส่วนตัวกับทีมงาน',
      components: [ticketOpenButton(staffRole?.id ?? '0')],
      allowedMentions: { parse: [] },
    });
    await interaction.reply({ content: `สร้างแผงแจ้งปัญหาแล้ว: ${panel.url}`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error(`สร้างแผงแจ้งปัญหาไม่สำเร็จ: ${error?.message ?? error}`);
    await interaction.reply({ content: 'สร้างแผงไม่ได้ ตรวจสิทธิ์ Send Messages และ Manage Channels ของบอท', flags: MessageFlags.Ephemeral });
  }
}

async function handleTicketOpen(interaction, staffRoleId) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'ปุ่มนี้ใช้ได้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`ticket-submit:${staffRoleId}`)
    .setTitle('แจ้งปัญหากับทีมงาน')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('อธิบายปัญหาที่ต้องการแจ้ง')
          .setPlaceholder('พิมพ์รายละเอียดให้ทีมงานเข้าใจ')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(5)
          .setMaxLength(1000),
      ),
    );
  await interaction.showModal(modal);
}

async function handleTicketSubmit(interaction, staffRoleId) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'แบบฟอร์มนี้ใช้ได้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  const openTicket = interaction.guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText
    && channel.topic?.includes(`ticket-owner:${interaction.user.id}`)
    && channel.name.startsWith('ticket-'),
  );
  if (openTicket) {
    await interaction.reply({ content: `คุณมีห้องแจ้งปัญหาที่เปิดอยู่แล้ว: ${openTicket}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const description = interaction.fields.getTextInputValue('description').trim();
  const overwrites = [
    {
      id: interaction.guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: interaction.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
    },
  ];
  if (staffRoleId !== '0' && interaction.guild.roles.cache.has(staffRoleId)) {
    overwrites.push({
      id: staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages],
    });
  }

  try {
    const channel = await interaction.guild.channels.create({
      name: `ticket-${safeName(interaction.user.username)}-${interaction.user.id.slice(-4)}`,
      type: ChannelType.GuildText,
      topic: `ticket-owner:${interaction.user.id};staff-role:${staffRoleId}`,
      permissionOverwrites: overwrites,
      reason: `เปิดห้องแจ้งปัญหาโดย ${interaction.user.tag}`,
    });
    await channel.send({
      content: `## แจ้งปัญหาโดย <@${interaction.user.id}>\n${description}\n\nทีมงานจะเข้ามาช่วยในห้องนี้ เมื่อเสร็จแล้วกดปุ่มปิดห้อง`,
      components: [ticketCloseButton()],
      allowedMentions: { users: [interaction.user.id] },
    });
    await interaction.editReply(`เปิดห้องแจ้งปัญหาแล้ว: ${channel}`);
  } catch (error) {
    console.error(`เปิดห้องแจ้งปัญหาไม่สำเร็จ: ${error?.message ?? error}`);
    await interaction.editReply('เปิดห้องไม่ได้ ตรวจให้บอทมีสิทธิ์ Manage Channels และ View Channels');
  }
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !channel.guild) {
    await interaction.reply({ content: 'ใช้ปุ่มนี้ในห้องแจ้งปัญหาเท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  const ownerId = channel.topic?.match(/ticket-owner:(\d+)/)?.[1];
  const staffRoleId = channel.topic?.match(/staff-role:(\d+)/)?.[1];
  const isOwner = ownerId === interaction.user.id;
  const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || (staffRoleId && staffRoleId !== '0' && interaction.member?.roles?.cache?.has(staffRoleId));
  if (!ownerId || (!isOwner && !isStaff)) {
    await interaction.reply({ content: 'มีแค่เจ้าของห้องหรือทีมงานที่ปิดห้องนี้ได้', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  try {
    await channel.permissionOverwrites.edit(ownerId, { SendMessages: false });
    if (channel.name.startsWith('ticket-')) await channel.setName(`closed-${channel.name.slice(7)}`);
    await interaction.message.edit({
      content: `🔒 ห้องนี้ปิดแล้ว โดย <@${interaction.user.id}>`,
      components: [ticketCloseButton(true)],
      allowedMentions: { users: [interaction.user.id] },
    });
  } catch (error) {
    console.error(`ปิดห้องแจ้งปัญหาไม่สำเร็จ: ${error?.message ?? error}`);
    await interaction.followUp({ content: 'ปิดห้องไม่สำเร็จ ตรวจสิทธิ์ Manage Channels ของบอท', flags: MessageFlags.Ephemeral });
  }
}

async function handleWarn(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: 'ต้องมีสิทธิ์ Moderate Members เพื่อใช้คำสั่งเตือน', flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getMember('สมาชิก', true);
  const reason = interaction.options.getString('เหตุผล', true).trim();
  if (!target || target.id === interaction.user.id || target.id === interaction.guild.ownerId) {
    await interaction.reply({ content: 'เลือกสมาชิกคนนี้ไม่ได้ครับ', flags: MessageFlags.Ephemeral });
    return;
  }
  const actor = await interaction.guild.members.fetch(interaction.user.id);
  if (actor.id !== interaction.guild.ownerId && target.roles.highest.comparePositionTo(actor.roles.highest) >= 0) {
    await interaction.reply({ content: 'เตือนสมาชิกที่มียศเท่ากันหรือสูงกว่าคุณไม่ได้', flags: MessageFlags.Ephemeral });
    return;
  }
  const guildWarnings = store.warnings[interaction.guildId] ??= {};
  const userWarnings = guildWarnings[target.id] ??= [];
  userWarnings.push({ reason, moderatorId: interaction.user.id, at: new Date().toISOString() });
  if (userWarnings.length > 100) userWarnings.splice(0, userWarnings.length - 100);
  await saveStore();
  await interaction.reply({
    content: `⚠️ เตือน <@${target.id}> แล้ว (ทั้งหมด ${userWarnings.length} ครั้ง)\nเหตุผล: ${reason}`,
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral,
  });
}

async function handleBan(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    await interaction.reply({ content: 'ต้องมีสิทธิ์ Ban Members เพื่อใช้คำสั่งแบน', flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getUser('ผู้ใช้', true);
  const reason = interaction.options.getString('เหตุผล', true).trim();
  if (target.id === interaction.user.id || target.id === interaction.client.user.id || target.id === interaction.guild.ownerId) {
    await interaction.reply({ content: 'แบนผู้ใช้นี้ไม่ได้ครับ', flags: MessageFlags.Ephemeral });
    return;
  }
  const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  const actor = await interaction.guild.members.fetch(interaction.user.id);
  if (targetMember && actor.id !== interaction.guild.ownerId && targetMember.roles.highest.comparePositionTo(actor.roles.highest) >= 0) {
    await interaction.reply({ content: 'แบนสมาชิกที่มียศเท่ากันหรือสูงกว่าคุณไม่ได้', flags: MessageFlags.Ephemeral });
    return;
  }
  if (targetMember) {
    const botMember = await interaction.guild.members.fetchMe();
    if (targetMember.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
      await interaction.reply({ content: 'ยศของสมาชิกเป้าหมายสูงกว่าหรือเท่ากับยศบอท ย้ายยศบอทให้สูงขึ้นก่อน', flags: MessageFlags.Ephemeral });
      return;
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await interaction.guild.members.ban(target.id, { deleteMessageSeconds: 600, reason });
    await interaction.editReply(`🔨 แบน ${target.tag} แล้ว\nเหตุผล: ${reason}`);
  } catch (error) {
    console.error(`แบนสมาชิกไม่สำเร็จ: ${error?.message ?? error}`);
    await interaction.editReply('แบนไม่สำเร็จ ตรวจสิทธิ์ Ban Members และลำดับยศของบอท');
  }
}

export async function handleServerFeatureCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName === 'welcome-setup') await handleWelcomeSetup(interaction);
  else if (interaction.commandName === 'ticket-panel') await handleTicketPanel(interaction);
  else if (interaction.commandName === 'warn') await handleWarn(interaction);
  else if (interaction.commandName === 'ban') await handleBan(interaction);
  else return false;
  return true;
}

export async function handleServerFeatureInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith('ticket-open:')) {
    await handleTicketOpen(interaction, interaction.customId.slice('ticket-open:'.length));
    return true;
  }
  if (interaction.isButton() && interaction.customId === 'ticket-close') {
    await handleTicketClose(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket-submit:')) {
    await handleTicketSubmit(interaction, interaction.customId.slice('ticket-submit:'.length));
    return true;
  }
  return false;
}

export function registerServerFeatureEvents(client) {
  client.on('guildMemberAdd', async member => {
    const channelId = store.guilds[member.guild.id]?.welcomeChannelId;
    if (!channelId) return;
    const channel = member.guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    try {
      await channel.send({
        content: `👋 ยินดีต้อนรับ ${member} เข้าสู่ **${member.guild.name}**! กดปุ่มยืนยันตัวตนเพื่อเริ่มใช้งานได้เลย`,
        allowedMentions: { users: [member.id] },
      });
    } catch (error) {
      console.error(`ส่งข้อความต้อนรับไม่สำเร็จ: ${error?.message ?? error}`);
    }
  });

  client.on('messageCreate', async message => {
    if (!message.guild || !message.member || message.author.bot) return;
    const actorPermissions = message.member.permissions;
    if (actorPermissions.has(PermissionFlagsBits.Administrator)
      || actorPermissions.has(PermissionFlagsBits.ManageMessages)
      || actorPermissions.has(PermissionFlagsBits.BanMembers)) return;

    const now = message.createdTimestamp;
    const key = `${message.guild.id}:${message.author.id}`;
    const previous = spamWindows.get(key) ?? [];
    const recent = previous.filter(entry => now - entry.at <= Math.max(SPAM_WINDOW_MS, DUPLICATE_WINDOW_MS));
    const normalized = message.content?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
    const next = [...recent, { at: now, content: normalized }];
    spamWindows.set(key, next);

    const burstCount = next.filter(entry => now - entry.at <= SPAM_WINDOW_MS).length;
    const duplicateCount = normalized
      ? next.filter(entry => now - entry.at <= DUPLICATE_WINDOW_MS && entry.content === normalized).length
      : 0;
    if (burstCount < SPAM_MESSAGE_LIMIT && duplicateCount < DUPLICATE_MESSAGE_LIMIT) return;
    if (banInProgress.has(key)) return;

    banInProgress.add(key);
    spamWindows.delete(key);
    try {
      await message.guild.members.ban(message.author.id, {
        deleteMessageSeconds: 600,
        reason: `Auto-ban: spam detected (${burstCount} messages/5s, ${duplicateCount} duplicates/10s)`,
      });
    } catch (error) {
      console.error(`แบนผู้ส่งสแปมอัตโนมัติไม่สำเร็จ: ${error?.message ?? error}`);
    } finally {
      banInProgress.delete(key);
    }
  });

  const spamWindowSweep = setInterval(() => {
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (const [key, entries] of spamWindows) {
      const recent = entries.filter(entry => entry.at >= cutoff);
      if (recent.length) spamWindows.set(key, recent);
      else spamWindows.delete(key);
    }
  }, 60_000);
  spamWindowSweep.unref();
}
