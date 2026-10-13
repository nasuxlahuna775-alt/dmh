import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { randomInt, randomUUID } from 'node:crypto';
import {
  handleServerFeatureCommand,
  handleServerFeatureInteraction,
  loadServerFeatureStore,
  registerServerFeatureEvents,
} from './server-features.js';
import { handleMusicCommand, handleMusicInteraction } from './music.js';

const { DISCORD_TOKEN } = process.env;
const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const ollamaModel = process.env.OLLAMA_MODEL || 'qwen3:4b';

if (!DISCORD_TOKEN) {
  throw new Error('กรุณาตั้งค่า DISCORD_TOKEN ในไฟล์ .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const verificationSessions = new Map();
const verificationBlocks = new Map();
const VERIFY_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const VERIFY_BLOCK_MS = 10 * 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 3;
registerServerFeatureEvents(client);

function verificationKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function pruneVerificationState(now = Date.now()) {
  for (const [key, session] of verificationSessions) {
    if (session.expiresAt <= now) verificationSessions.delete(key);
  }
  for (const [key, blockedUntil] of verificationBlocks) {
    if (blockedUntil <= now) verificationBlocks.delete(key);
  }
}

function createVerificationSession(key, roleId, minAccountAgeDays) {
  const left = randomInt(12, 50);
  const right = randomInt(2, 10);
  const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
  const session = {
    roleId,
    minAccountAgeDays,
    answer: String(left * right),
    question: `${left} × ${right} = เท่าไร?`,
    attempts: 0,
    nonce,
    expiresAt: Date.now() + VERIFY_CHALLENGE_TTL_MS,
  };
  verificationSessions.set(key, session);
  return session;
}

function buildVerificationModal(session) {
  const answerInput = new TextInputBuilder()
    .setCustomId('answer')
    .setLabel(session.question)
    .setPlaceholder('พิมพ์คำตอบเป็นตัวเลข')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3);
  const row = new ActionRowBuilder().addComponents(answerInput);

  return new ModalBuilder()
    .setCustomId(`verify-answer:${session.roleId}:${session.nonce}`)
    .setTitle('ตรวจสอบก่อนรับยศ')
    .addComponents(row);
}

client.once(Events.ClientReady, readyClient => {
  console.log(`บอทออนไลน์แล้ว: ${readyClient.user.tag}`);
  console.log(`ใช้ Ollama รุ่น ${ollamaModel} ที่ ${ollamaHost}`);
});

async function handleVerifyPanel(interaction) {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({ content: 'คำสั่งนี้ใช้ได้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'คำสั่งนี้ให้แอดมินเซิร์ฟเวอร์ใช้เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }

  const role = interaction.options.getRole('ยศ', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const botMember = await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply('บอทยังไม่มีสิทธิ์ Manage Roles ให้เปิดสิทธิ์นี้ใน Discord ก่อน');
      return;
    }
    if (role.managed || role.comparePositionTo(botMember.roles.highest) >= 0) {
      await interaction.editReply('ยศบอทต้องอยู่สูงกว่ายศที่จะมอบ และยศนั้นต้องไม่ใช่ยศที่จัดการโดยบอทอื่น');
      return;
    }
    if (typeof interaction.channel.send !== 'function') {
      await interaction.editReply('ช่องนี้ส่งข้อความไม่ได้ ลองใช้คำสั่งในห้องข้อความ');
      return;
    }

    const button = new ButtonBuilder()
      .setCustomId(`verify-role:${role.id}:${interaction.options.getInteger('อายุบัญชี') ?? 7}`)
      .setLabel('ยืนยันตัวตน')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);

    const panelMessage = await interaction.channel.send({
      content: `## ✅ ยืนยันตัวตน\nกดปุ่มแล้วตอบโจทย์ตรวจสอบเพื่อรับยศ <@&${role.id}>${(interaction.options.getInteger('อายุบัญชี') ?? 7) > 0 ? `\nบัญชี Discord ต้องมีอายุอย่างน้อย ${interaction.options.getInteger('อายุบัญชี') ?? 7} วัน` : ''}`,
      components: [row],
      allowedMentions: { parse: [] },
    });
    await interaction.editReply(`สร้างปุ่มยืนยันตัวตนแล้ว: ${panelMessage.url}`);
  } catch (error) {
    console.error(`สร้างแผงยืนยันตัวตนไม่สำเร็จ: ${error?.message ?? error}`);
    const message = error?.code === 50013
      ? 'บอทไม่มีสิทธิ์ส่งข้อความหรือจัดการยศ ตรวจสิทธิ์ Manage Roles และลำดับยศของบอท'
      : 'สร้างปุ่มยืนยันตัวตนไม่สำเร็จ ตรวจสิทธิ์ของบอทแล้วลองใหม่';
    await interaction.editReply(message);
  }
}

async function handleVerifyButton(interaction, roleId, minAccountAgeDays) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'ปุ่มนี้ใช้ได้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }

  const now = Date.now();
  pruneVerificationState(now);
  const key = verificationKey(interaction.guild.id, interaction.user.id);
  const blockedUntil = verificationBlocks.get(key);
  if (blockedUntil && blockedUntil > now) {
    const minutes = Math.ceil((blockedUntil - now) / 60_000);
    await interaction.reply({ content: `ลองยืนยันใหม่ได้ในอีกประมาณ ${minutes} นาที`, flags: MessageFlags.Ephemeral });
    return;
  }

  const accountAgeDays = Math.floor((now - interaction.user.createdTimestamp) / 86_400_000);
  if (accountAgeDays < minAccountAgeDays) {
    await interaction.reply({
      content: `บัญชี Discord ของคุณต้องมีอายุอย่างน้อย ${minAccountAgeDays} วันจึงจะยืนยันได้`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = verificationSessions.get(key);
  const activeSession = session?.expiresAt > now
    ? session
    : createVerificationSession(key, roleId, minAccountAgeDays);
  await interaction.showModal(buildVerificationModal(activeSession));
}

async function handleVerifyAnswer(interaction, roleId, nonce) {
  if (!interaction.guild) {
    await interaction.reply({ content: 'แบบยืนยันนี้ใช้ได้ในเซิร์ฟเวอร์เท่านั้น', flags: MessageFlags.Ephemeral });
    return;
  }

  pruneVerificationState();
  const key = verificationKey(interaction.guild.id, interaction.user.id);
  const session = verificationSessions.get(key);
  if (!session || session.roleId !== roleId || session.nonce !== nonce) {
    await interaction.reply({ content: 'โจทย์หมดอายุแล้ว กดปุ่มยืนยันตัวตนเพื่อเริ่มใหม่', flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.expiresAt <= Date.now()) {
    verificationSessions.delete(key);
    await interaction.reply({ content: 'หมดเวลายืนยันแล้ว กดปุ่มเพื่อเริ่มใหม่', flags: MessageFlags.Ephemeral });
    return;
  }

  const submittedAnswer = interaction.fields.getTextInputValue('answer').trim();
  if (submittedAnswer !== session.answer) {
    session.attempts += 1;
    if (session.attempts >= VERIFY_MAX_ATTEMPTS) {
      verificationSessions.delete(key);
      verificationBlocks.set(key, Date.now() + VERIFY_BLOCK_MS);
      await interaction.reply({ content: 'ตอบผิดครบ 3 ครั้ง ลองยืนยันใหม่ได้ในอีก 10 นาที', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: `คำตอบไม่ถูก ลองใหม่ได้อีก ${VERIFY_MAX_ATTEMPTS - session.attempts} ครั้ง แล้วกดปุ่มยืนยันตัวตนอีกครั้ง`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  verificationSessions.delete(key);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const role = await interaction.guild.roles.fetch(roleId);
    if (!role) {
      await interaction.editReply('ไม่พบยศนี้แล้ว กรุณาให้แอดมินสร้างปุ่มใหม่');
      return;
    }
    if (member.roles.cache.has(role.id)) {
      await interaction.editReply('คุณได้รับยศนี้แล้ว ✅');
      return;
    }

    const accountAgeDays = Math.floor((Date.now() - interaction.user.createdTimestamp) / 86_400_000);
    if (accountAgeDays < session.minAccountAgeDays) {
      await interaction.editReply(`บัญชี Discord ต้องมีอายุอย่างน้อย ${session.minAccountAgeDays} วันจึงจะยืนยันได้`);
      return;
    }

    const botMember = await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply('บอทยังไม่มีสิทธิ์ Manage Roles ให้แจ้งแอดมินเซิร์ฟเวอร์');
      return;
    }
    if (role.managed || role.comparePositionTo(botMember.roles.highest) >= 0) {
      await interaction.editReply('บอทมอบยศนี้ไม่ได้ ให้แอดมินย้ายยศบอทให้อยู่สูงกว่ายศที่ต้องการ');
      return;
    }

    await member.roles.add(role, 'สมาชิกผ่านโจทย์ยืนยันตัวตน');
    await interaction.editReply('✅ ยืนยันตัวตนสำเร็จ รับยศเรียบร้อยแล้ว');
  } catch (error) {
    console.error(`มอบยศหลังยืนยันไม่สำเร็จ: ${error?.message ?? error}`);
    const message = error?.code === 50013
      ? 'บอทมอบยศไม่ได้ ตรวจสิทธิ์ Manage Roles และย้ายยศบอทให้อยู่สูงกว่ายศเป้าหมาย'
      : 'ยืนยันตัวตนไม่สำเร็จ ลองอีกครั้งหรือแจ้งแอดมินเซิร์ฟเวอร์';
    await interaction.editReply(message);
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
  if (await handleServerFeatureInteraction(interaction)) return;
  if (await handleMusicInteraction(interaction)) return;

  if (interaction.isButton() && interaction.customId.startsWith('verify-role:')) {
    const match = interaction.customId.match(/^verify-role:(\d+)(?::(\d+))?$/);
    if (!match) return;
    await handleVerifyButton(interaction, match[1], Number(match[2] ?? 7));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('verify-answer:')) {
    const match = interaction.customId.match(/^verify-answer:(\d+):([a-f\d]+)$/i);
    if (!match) return;
    await handleVerifyAnswer(interaction, match[1], match[2]);
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (await handleServerFeatureCommand(interaction)) return;
  if (await handleMusicCommand(interaction)) return;
  if (interaction.commandName === 'verify-panel') {
    await handleVerifyPanel(interaction);
    return;
  }
  if (interaction.commandName !== 'ask') return;

  const question = interaction.options.getString('คำถาม', true);

  try {
    await interaction.deferReply();
    const response = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [
          {
            role: 'system',
            content: 'คุณเป็นผู้ช่วย AI ที่เป็นมิตร ตอบเป็นภาษาไทยเท่านั้น ให้คำตอบสั้นและตรงประเด็น ห้ามแสดงการวิเคราะห์หรือความคิดภายใน ให้แสดงเฉพาะคำตอบที่พร้อมส่งให้ผู้ใช้ /no_think',
          },
          { role: 'user', content: `${question}\n/no_think` },
        ],
        stream: true,
        think: false,
        keep_alive: '10m',
        options: { num_predict: 300, num_ctx: 4096 },
      }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Ollama ตอบกลับ ${response.status}: ${details}`);
    }
    if (!response.body) throw new Error('Ollama ไม่ได้ส่งข้อมูลคำตอบกลับมา');

    let answer = '';
    let buffer = '';
    const decoder = new TextDecoder();

    const readLine = async line => {
      if (!line.trim()) return;

      const chunk = JSON.parse(line);
      if (chunk.error) throw new Error(chunk.error);

      const text = chunk.message?.content || '';
      if (!text) return;

      answer += text;
    };

    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await readLine(line);
      if (done) break;
    }
    if (buffer.trim()) await readLine(buffer);

    // ซ่อนบล็อกความคิดที่บางรุ่นอาจส่งมาปนกับคำตอบ
    answer = answer
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/gi, '')
      .replace(/<\/?think>/gi, '')
      .replace(/^\s*\/no_think\s*/gim, '')
      .trim() || 'ขอโทษที ตอนนี้ยังตอบคำถามนี้ไม่ได้';
    // Discord จำกัดข้อความต่อครั้ง จึงแบ่งคำตอบยาวเป็นหลายข้อความ
    const chunks = answer.match(/[\s\S]{1,1900}/g) || ['ขอโทษที ตอนนี้ยังตอบคำถามนี้ไม่ได้'];
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
  } catch (error) {
    // ถ้าโปรเซสบอทอีกตัวตอบ interaction ไปแล้ว หรือ interaction หมดเวลา ให้ข้ามโดยไม่ทำให้บอทล่ม
    if (error?.code === 10062 || error?.code === 40060) {
      console.warn(`Discord ปฏิเสธ interaction ที่หมดเวลาหรือถูกตอบไปแล้ว (${error.code})`);
      return;
    }

    console.error(`เรียก Ollama ไม่สำเร็จ: ${error?.message ?? error}`);

    const message = error?.name === 'TimeoutError'
      ? 'AI ใช้เวลาคิดนานเกินไป ลองถามสั้นลงหรือใช้โมเดลขนาดเล็กลง'
      : error?.message?.includes('fetch failed') || error?.cause?.code === 'ECONNREFUSED'
        ? 'ยังต่อ Ollama ไม่ได้ เปิดแอป Ollama แล้วรันคำสั่ง ollama run qwen3:4b ก่อน'
        : error?.message?.toLowerCase().includes('not found')
          ? `ยังไม่มีโมเดล ${ollamaModel} ให้เปิด Ollama แล้วรันคำสั่ง ollama run ${ollamaModel}`
          : 'ขอโทษที เกิดปัญหาตอนเรียก AI กรุณาลองใหม่อีกครั้ง';

    try {
      await interaction.editReply(message);
    } catch (replyError) {
      console.error(`ส่งข้อความแจ้ง error ไม่สำเร็จ: ${replyError?.message ?? replyError}`);
    }
  }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    console.error(`จัดการคำสั่งไม่สำเร็จ: ${error?.message ?? error}`);
    try {
      if (interaction.deferred) await interaction.editReply('คำสั่งนี้ทำงานไม่สำเร็จ ตรวจสิทธิ์บอทแล้วลองอีกครั้ง');
      else if (!interaction.replied) await interaction.reply({ content: 'คำสั่งนี้ทำงานไม่สำเร็จ ตรวจสิทธิ์บอทแล้วลองอีกครั้ง', flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      console.error(`ส่งข้อความแจ้งปัญหาไม่สำเร็จ: ${replyError?.message ?? replyError}`);
    }
  }
});

await loadServerFeatureStore();
client.login(DISCORD_TOKEN);
