const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');

const TOKEN = 'BOT TOKEN HERE';
const CLIENT_ID = 'APPLICATION_ID HERE';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ---------------------------------------------------------------------------
// Memory: store channels per server
// ---------------------------------------------------------------------------
const lastSession  = new Map(); // guildId -> { lobby, team1, team2 }
const lastSession2 = new Map(); // guildId -> { lobbyteam1, team2 }

// ---------------------------------------------------------------------------
// Helper: get or create the Spectator role
// ---------------------------------------------------------------------------
async function getOrCreateSpectatorRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Spectator');
  if (!role) {
    role = await guild.roles.create({
      name: 'Spectator',
      color: 0x95a5a6,
      reason: 'Auto-created by PugsBot for spectators',
    });
  }
  return role;
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a specific user to a voice channel')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to move').setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Target voice channel').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('moveall')
    .setDescription('Move everyone from one voice channel to another')
    .addChannelOption(opt =>
      opt.setName('from').setDescription('Source voice channel').setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('to').setDescription('Target voice channel').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('moveme')
    .setDescription('Move yourself to a voice channel')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Target voice channel').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('randomteams')
    .setDescription('Randomly split lobby into two equal teams and move them')
    .addChannelOption(opt =>
      opt.setName('lobby').setDescription('Lobby channel (only needed the first time)').setRequired(false)
    )
    .addChannelOption(opt =>
      opt.setName('team1').setDescription('Team 1 channel (only needed the first time)').setRequired(false)
    )
    .addChannelOption(opt =>
      opt.setName('team2').setDescription('Team 2 channel (only needed the first time)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('done')
    .setDescription('Move everyone from Team1 and Team2 back to the lobby'),

  new SlashCommandBuilder()
    .setName('randomteams2')
    .setDescription('Split lobby into two teams — only moves Team2, Team1 stays in lobby')
    .addChannelOption(opt =>
      opt.setName('lobbyteam1').setDescription('Lobby/Team1 channel (only needed the first time)').setRequired(false)
    )
    .addChannelOption(opt =>
      opt.setName('team2').setDescription('Team 2 channel (only needed the first time)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('done2')
    .setDescription('Move Team2 back to the Lobby/Team1 channel'),

  new SlashCommandBuilder()
    .setName('spectator')
    .setDescription('Toggle the Spectator role on a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to make a spectator (or remove spectator from)').setRequired(true)
    ),

].map(cmd => cmd.toJSON());

// ---------------------------------------------------------------------------
// Register commands on startup
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, 'SERVER_ID HERE'), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ---------------------------------------------------------------------------
// Handle interactions
// ---------------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // --- Permission check ---
  if (!interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: '❌ You need Administrator permissions to use this bot.', ephemeral: true });
  }

  // --- /move ---
  if (commandName === 'move') {
    const targetUser = interaction.options.getMember('user');
    const targetChannel = interaction.options.getChannel('channel');

    if (targetChannel.type !== 2) {
      return interaction.reply({ content: '❌ That is not a voice channel.', ephemeral: true });
    }

    if (!targetUser.voice.channel) {
      return interaction.reply({ content: '❌ That user is not in a voice channel.', ephemeral: true });
    }

    try {
      await targetUser.voice.setChannel(targetChannel);
      await interaction.reply(`✅ Moved **${targetUser.displayName}** to **${targetChannel.name}**.`);
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to move user. Check my permissions.', ephemeral: true });
    }
  }

  // --- /moveall ---
  else if (commandName === 'moveall') {
    const fromChannel = interaction.options.getChannel('from');
    const toChannel = interaction.options.getChannel('to');

    if (fromChannel.type !== 2 || toChannel.type !== 2) {
      return interaction.reply({ content: '❌ Both channels must be voice channels.', ephemeral: true });
    }

    const members = fromChannel.members;
    if (members.size === 0) {
      return interaction.reply({ content: '❌ No one is in that channel.', ephemeral: true });
    }

    await interaction.deferReply();

    const results = await Promise.allSettled(
      members.map(member => member.voice.setChannel(toChannel))
    );

    const moved = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    await interaction.editReply(
      `✅ Moved **${moved}** member(s) to **${toChannel.name}**` +
      (failed > 0 ? ` (${failed} failed — missing permissions?)` : '.')
    );
  }

  // --- /randomteams ---
  else if (commandName === 'randomteams') {
    const lobbyOption = interaction.options.getChannel('lobby');
    const team1Option = interaction.options.getChannel('team1');
    const team2Option = interaction.options.getChannel('team2');

    const existing = lastSession.get(interaction.guildId);

    const lobbyChannel = lobbyOption || existing?.lobby;
    const team1Channel = team1Option || existing?.team1;
    const team2Channel = team2Option || existing?.team2;

    if (!lobbyChannel || !team1Channel || !team2Channel) {
      return interaction.reply({
        content: '❌ No saved channels found. Please provide #lobby, #team1 and #team2 the first time.',
        ephemeral: true,
      });
    }

    if (lobbyChannel.type !== 2 || team1Channel.type !== 2 || team2Channel.type !== 2) {
      return interaction.reply({ content: '❌ All three channels must be voice channels.', ephemeral: true });
    }

    const spectatorRole1 = interaction.guild.roles.cache.find(r => r.name === 'Spectator');
    const members = [...lobbyChannel.members.values()].filter(m =>
      !spectatorRole1 || !m.roles.cache.has(spectatorRole1.id)
    );

    if (members.length < 2) {
      return interaction.reply({ content: '❌ Need at least 2 non-spectator people in the lobby to make teams.', ephemeral: true });
    }

    await interaction.deferReply();

    // Shuffle using Fisher-Yates
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    const half = Math.floor(members.length / 2);
    const team1 = members.slice(0, half);
    const team2 = members.slice(half);

    await Promise.all([
      ...team1.map(m => m.voice.setChannel(team1Channel)),
      ...team2.map(m => m.voice.setChannel(team2Channel)),
    ]);

    lastSession.set(interaction.guildId, {
      lobby: lobbyChannel,
      team1: team1Channel,
      team2: team2Channel,
    });

    const fmt = team => team.map(m => `• ${m.displayName}`).join('\n');

    await interaction.editReply(
      `🎮 Teams randomized!\n\n` +
      `**${team1Channel.name}** (${team1.length})\n${fmt(team1)}\n\n` +
      `**${team2Channel.name}** (${team2.length})\n${fmt(team2)}\n\n` +
      `*Use /done to move everyone back to the lobby.*`
    );
  }

  // --- /done ---
  else if (commandName === 'done') {
    const session = lastSession.get(interaction.guildId);

    if (!session) {
      return interaction.reply({ content: '❌ No session found. Run /randomteams first.', ephemeral: true });
    }

    const { lobby: lobbyChannel, team1: team1Channel, team2: team2Channel } = session;

    const members = [
      ...team1Channel.members.values(),
      ...team2Channel.members.values(),
    ];

    if (members.length === 0) {
      return interaction.reply({ content: '❌ No one is in Team1 or Team2.', ephemeral: true });
    }

    await interaction.deferReply();

    const results = await Promise.allSettled(
      members.map(m => m.voice.setChannel(lobbyChannel))
    );

    const moved = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    await interaction.editReply(
      `✅ Moved **${moved}** player(s) back to **${lobbyChannel.name}**` +
      (failed > 0 ? ` (${failed} failed — missing permissions?)` : '.')
    );
  }

  // --- /randomteams2 ---
  else if (commandName === 'randomteams2') {
    const lobbyTeam1Option = interaction.options.getChannel('lobbyteam1');
    const team2Option      = interaction.options.getChannel('team2');

    const existing = lastSession2.get(interaction.guildId);

    const lobbyTeam1Channel = lobbyTeam1Option || existing?.lobbyteam1;
    const team2Channel      = team2Option      || existing?.team2;

    if (!lobbyTeam1Channel || !team2Channel) {
      return interaction.reply({
        content: '❌ No saved channels found. Please provide #lobbyteam1 and #team2 the first time.',
        ephemeral: true,
      });
    }

    if (lobbyTeam1Channel.type !== 2 || team2Channel.type !== 2) {
      return interaction.reply({ content: '❌ Both channels must be voice channels.', ephemeral: true });
    }

    const spectatorRole2 = interaction.guild.roles.cache.find(r => r.name === 'Spectator');
    const members = [...lobbyTeam1Channel.members.values()].filter(m =>
      !spectatorRole2 || !m.roles.cache.has(spectatorRole2.id)
    );

    if (members.length < 2) {
      return interaction.reply({ content: '❌ Need at least 2 non-spectator people in the channel to make teams.', ephemeral: true });
    }

    await interaction.deferReply();

    // Shuffle using Fisher-Yates
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    const half  = Math.floor(members.length / 2);
    const team1 = members.slice(0, half);  // stays in lobbyteam1
    const team2 = members.slice(half);     // only these get moved

    await Promise.allSettled(team2.map(m => m.voice.setChannel(team2Channel)));

    lastSession2.set(interaction.guildId, {
      lobbyteam1: lobbyTeam1Channel,
      team2: team2Channel,
    });

    const fmt = team => team.map(m => `• ${m.displayName}`).join('\n');

    await interaction.editReply(
      `🎮 Teams randomized!\n\n` +
      `**${lobbyTeam1Channel.name}** (${team1.length})\n${fmt(team1)}\n\n` +
      `**${team2Channel.name}** (${team2.length})\n${fmt(team2)}\n\n` +
      `*Use /done2 to move Team2 back.*`
    );
  }

  // --- /done2 ---
  else if (commandName === 'done2') {
    const session = lastSession2.get(interaction.guildId);

    if (!session) {
      return interaction.reply({ content: '❌ No session found. Run /randomteams2 first.', ephemeral: true });
    }

    const { lobbyteam1: lobbyTeam1Channel, team2: team2Channel } = session;

    const members = [...team2Channel.members.values()];

    if (members.length === 0) {
      return interaction.reply({ content: '❌ No one is in Team2.', ephemeral: true });
    }

    await interaction.deferReply();

    const results = await Promise.allSettled(
      members.map(m => m.voice.setChannel(lobbyTeam1Channel))
    );

    const moved = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    await interaction.editReply(
      `✅ Moved **${moved}** player(s) back to **${lobbyTeam1Channel.name}**` +
      (failed > 0 ? ` (${failed} failed — missing permissions?)` : '.')
    );
  }

  // --- /spectator ---
  else if (commandName === 'spectator') {
    const targetUser = interaction.options.getMember('user');

    try {
      const role = await getOrCreateSpectatorRole(interaction.guild);

      if (targetUser.roles.cache.has(role.id)) {
        await targetUser.roles.remove(role);
        await interaction.reply(`👁️ Removed **Spectator** role from **${targetUser.displayName}**.`);
      } else {
        await targetUser.roles.add(role);
        await interaction.reply(`👁️ **${targetUser.displayName}** is now a **Spectator**.`);
      }
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to update role. Make sure the bot role is above the Spectator role in the server settings.', ephemeral: true });
    }
  }

  // --- /moveme ---
  else if (commandName === 'moveme') {
    const member = interaction.member;
    const targetChannel = interaction.options.getChannel('channel');

    if (targetChannel.type !== 2) {
      return interaction.reply({ content: '❌ That is not a voice channel.', ephemeral: true });
    }

    if (!member.voice.channel) {
      return interaction.reply({ content: '❌ You must be in a voice channel first.', ephemeral: true });
    }

    try {
      await member.voice.setChannel(targetChannel);
      await interaction.reply({ content: `✅ Moved you to **${targetChannel.name}**.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to move you. Check my permissions.', ephemeral: true });
    }
  }
});

client.login(TOKEN);