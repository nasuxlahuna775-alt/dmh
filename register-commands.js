import 'dotenv/config';
import { ChannelType, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('กรุณาตั้งค่า DISCORD_TOKEN และ DISCORD_CLIENT_ID ในไฟล์ .env');
}

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('ถามคำถามกับ AI')
    .addStringOption(option =>
      option.setName('คำถาม').setDescription('พิมพ์คำถามของคุณ').setRequired(true).setMaxLength(2000),
    ),
  new SlashCommandBuilder()
    .setName('verify-panel')
    .setDescription('สร้างปุ่มยืนยันตัวตนเพื่อรับยศ')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(option =>
      option.setName('ยศ').setDescription('ยศที่จะให้หลังจากสมาชิกยืนยันตัวตน').setRequired(true),
    )
    .addIntegerOption(option =>
      option
        .setName('อายุบัญชี')
        .setDescription('อายุบัญชี Discord ขั้นต่ำเป็นวัน (0 คือไม่ตรวจอายุ)')
        .setMinValue(0)
        .setMaxValue(30)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('welcome-setup')
    .setDescription('ตั้งห้องต้อนรับสมาชิกใหม่')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option
        .setName('ช่อง')
        .setDescription('ห้องข้อความสำหรับต้อนรับสมาชิกใหม่')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('สร้างปุ่มเปิดห้องแจ้งปัญหาส่วนตัว')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(option =>
      option.setName('ทีมงาน').setDescription('ยศทีมงานที่จะเห็นห้องแจ้งปัญหา').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('เตือนสมาชิกพร้อมบันทึกเหตุผล')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName('สมาชิก').setDescription('สมาชิกที่ต้องการเตือน').setRequired(true),
    )
    .addStringOption(option =>
      option.setName('เหตุผล').setDescription('เหตุผลที่เตือน').setRequired(true).setMaxLength(500),
    ),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('แบนผู้ใช้และลบข้อความย้อนหลัง 10 นาที')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(option =>
      option.setName('ผู้ใช้').setDescription('ผู้ใช้ที่ต้องการแบน').setRequired(true),
    )
    .addStringOption(option =>
      option.setName('เหตุผล').setDescription('เหตุผลที่แบน').setRequired(true).setMaxLength(500),
    ),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('เปิดเพลงจากลิงก์ YouTube พร้อมแผงควบคุม')
    .addStringOption(option =>
      option
        .setName('ลิงก์')
        .setDescription('ลิงก์วิดีโอ YouTube ที่ต้องการเล่น')
        .setRequired(true)
        .setMaxLength(500),
    ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
console.log('ลงทะเบียนคำสั่ง AI, เพลง, ยืนยันตัวตน, ต้อนรับ, แจ้งปัญหา และดูแลสมาชิกเรียบร้อยแล้ว');
