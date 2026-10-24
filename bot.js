import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const token = process.env.Discord_token || process.env.DISCORD_TOKEN;

// Only standard intents required (No privileged MessageContent needed)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

client.once("ready", () => {
  console.log(`🤖 Discord Bot logged in as ${client.user.tag}!`);
  console.log(`🚀 Click the Rocket / Activity icon in Discord voice channels to launch!`);
});

// Supports slash command / interaction
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "watch") {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: "⚠️ You must join a voice channel first to start TachyonStream!",
        ephemeral: true
      });
    }

    try {
      await interaction.deferReply();

      const invite = await voiceChannel.createInvite({
        targetApplication: client.user.id,
        targetType: 2, // 2 = EMBEDDED_APPLICATION
        maxAge: 86400,
        maxUses: 0
      });

      return interaction.editReply({
        content: `🎬 **TachyonStream Activity is ready!**\nClick below to launch:\n👉 https://discord.gg/${invite.code}`
      });
    } catch (error) {
      console.error("Error creating Activity invite:", error);
      return interaction.editReply({
        content: "❌ Failed to create activity. Please make sure the bot has **Create Instant Invite** permission!"
      });
    }
  }
});

if (token) {
  client.login(token);
} else {
  console.error("❌ No Discord_token found in .env file!");
}
