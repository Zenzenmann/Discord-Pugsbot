const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID;

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
const lastSession = new Map(); // guildId -> { lobbyteam1, team2, team1Members, team2Members }

// ---------------------------------------------------------------------------
// SR / Elo System
// ---------------------------------------------------------------------------
const SR_FILE = path.join(__dirname, 'sr_data.json');

const DEFAULT_SR = 1000;
const K_FACTOR   = 32;

function loadSR() {
  try {
    if (fs.existsSync(SR_FILE)) {
      return JSON.parse(fs.readFileSync(SR_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load SR data:', err);
  }
  return {};
}

function saveSR(data) {
  try {
    fs.writeFileSync(SR_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save SR data:', err);
  }
}

function getPlayer(data, userId, displayName) {
  if (!data[userId]) {
    data[userId] = { displayName, sr: DEFAULT_SR, wins: 0, losses: 0 };
  } else {
    data[userId].displayName = displayName;
  }
  return data[userId];
}

function expectedScore(srA, srB) {
  return 1 / (1 + Math.pow(10, (srB - srA) / 400));
}

function applyElo(data, winners, losers) {
  const avgWin  = winners.reduce((s, p) => s + getPlayer(data, p.userId, p.displayName).sr, 0) / winners.length;
  const avgLose = losers.reduce( (s, p) => s + getPlayer(data, p.userId, p.displayName).sr, 0) / losers.length;

  const expWin  = expectedScore(avgWin,  avgLose);
  const expLose = expectedScore(avgLose, avgWin);

  const changes = {};

  for (const p of winners) {
    const player = getPlayer(data, p.userId, p.displayName);
    const delta  = Math.round(K_FACTOR * (1 - expWin));
    player.sr   += delta;
    player.wins += 1;
    changes[p.userId] = { name: player.displayName, delta: `+${delta}`, newSR: player.sr };
  }

  for (const p of losers) {
    const player  = getPlayer(data, p.userId, p.displayName);
    const delta   = Math.round(K_FACTOR * (0 - expLose));
    player.sr     = Math.max(0, player.sr + delta);
    player.losses += 1;
    changes[p.userId] = { name: player.displayName, delta: delta.toString(), newSR: player.sr };
  }

  saveSR(data);
  return changes;
}

// ---------------------------------------------------------------------------
// Helper: get or create the Spectator role
// ---------------------------------------------------------------------------
async function getOrCreateSpectatorRole(guild) {
  let role = guild.roles.cache.find(r => r.name === 'Spectator');
  if (!role) {
    role = await guild.roles.create({
      name:   'Spectator',
      color:  0x95a5a6,
      reason: 'Auto-created by PugsBot for spectators',
    });
  }
  return role;
}

// ---------------------------------------------------------------------------
// Rank System
// ---------------------------------------------------------------------------
const RANKS = [
  { name: 'Bronze',      min: 0,    color: 0xcd7f32 },
  { name: 'Silver',      min: 300,  color: 0xc0c0c0 },
  { name: 'Gold',        min: 800,  color: 0xffd700 },
  { name: 'Platinum',    min: 1100, color: 0x00c9a7 },
  { name: 'Diamond',     min: 1400, color: 0x7ec8e3 },
  { name: 'Master',      min: 1700, color: 0x9b59b6 },
  { name: 'Grandmaster', min: 2000, color: 0xff4500 },
];

function getRankForSR(sr) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (sr >= r.min) rank = r;
  }
  return rank;
}

/** Ensure all rank roles exist on the guild, returns a Map of name -> Role */
async function ensureRankRoles(guild) {
  const roleMap = new Map();
  for (const rank of RANKS) {
    let role = guild.roles.cache.find(r => r.name === rank.name);
    if (!role) {
      role = await guild.roles.create({
        name:   rank.name,
        color:  rank.color,
        reason: 'Auto-created by PugsBot rank system',
      });
    }
    roleMap.set(rank.name, role);
  }
  return roleMap;
}

/** Update a guild member's rank role based on their current SR */
async function updateRankRole(guild, userId, sr) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const roleMap   = await ensureRankRoles(guild);
  const newRank   = getRankForSR(sr);
  const rankNames = RANKS.map(r => r.name);

  // Remove all rank roles the member currently has
  const toRemove = member.roles.cache.filter(r => rankNames.includes(r.name));
  if (toRemove.size > 0) await member.roles.remove(toRemove);

  // Assign the correct rank role
  await member.roles.add(roleMap.get(newRank.name));
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
    .setDescription('Split lobby into two teams — Team1 stays in lobby, only Team2 gets moved')
    .addChannelOption(opt =>
      opt.setName('lobbyteam1').setDescription('Lobby/Team1 channel (only needed the first time)').setRequired(false)
    )
    .addChannelOption(opt =>
      opt.setName('team2').setDescription('Team 2 channel (only needed the first time)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('done')
    .setDescription('Move Team2 back to the Lobby/Team1 channel'),

  new SlashCommandBuilder()
    .setName('spectator')
    .setDescription('Toggle the Spectator role on a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to make a spectator (or remove spectator from)').setRequired(true)
    ),

  // SR Commands

  new SlashCommandBuilder()
    .setName('win')
    .setDescription('Record the winning team and update SR for everyone in the last session')
    .addStringOption(opt =>
      opt.setName('team')
        .setDescription('Which team won?')
        .setRequired(true)
        .addChoices(
          { name: 'Team 1', value: 'team1' },
          { name: 'Team 2', value: 'team2' },
        )
    ),

  new SlashCommandBuilder()
    .setName('sr')
    .setDescription('Show the SR, wins, losses and winrate of a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to look up (leave blank for yourself)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 players by SR'),

  new SlashCommandBuilder()
    .setName('resetsr')
    .setDescription("(Admin) Reset a specific user's SR back to the default")
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user to reset').setRequired(true)
    ),

].map(cmd => cmd.toJSON());

// ---------------------------------------------------------------------------
// Register commands on startup
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  // Create rank roles on all servers the bot is in
  for (const guild of client.guilds.cache.values()) {
    try {
      await ensureRankRoles(guild);
      console.log(`Rank roles ensured for guild: ${guild.name}`);
    } catch (err) {
      console.error(`Failed to create rank roles for guild ${guild.name}:`, err);
    }
  }
});

// ---------------------------------------------------------------------------
// Handle interactions
// ---------------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // Permission check (skip for /sr and /leaderboard)
  const publicCommands = ['sr', 'leaderboard'];
  if (!publicCommands.includes(commandName) && !interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
  }

  // --- /move ---
  if (commandName === 'move') {
    const targetUser    = interaction.options.getMember('user');
    const targetChannel = interaction.options.getChannel('channel');

    if (targetChannel.type !== 2)
      return interaction.reply({ content: '❌ That is not a voice channel.', ephemeral: true });
    if (!targetUser.voice.channel)
      return interaction.reply({ content: '❌ That user is not in a voice channel.', ephemeral: true });

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
    const toChannel   = interaction.options.getChannel('to');

    if (fromChannel.type !== 2 || toChannel.type !== 2)
      return interaction.reply({ content: '❌ Both channels must be voice channels.', ephemeral: true });

    const members = fromChannel.members;
    if (members.size === 0)
      return interaction.reply({ content: '❌ No one is in that channel.', ephemeral: true });

    await interaction.deferReply();

    const results = await Promise.allSettled(members.map(m => m.voice.setChannel(toChannel)));
    const moved   = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;

    await interaction.editReply(
      `✅ Moved **${moved}** member(s) to **${toChannel.name}**` +
      (failed > 0 ? ` (${failed} failed — missing permissions?)` : '.')
    );
  }

  // --- /moveme ---
  else if (commandName === 'moveme') {
    const member        = interaction.member;
    const targetChannel = interaction.options.getChannel('channel');

    if (targetChannel.type !== 2)
      return interaction.reply({ content: '❌ That is not a voice channel.', ephemeral: true });
    if (!member.voice.channel)
      return interaction.reply({ content: '❌ You must be in a voice channel first.', ephemeral: true });

    try {
      await member.voice.setChannel(targetChannel);
      await interaction.reply({ content: `✅ Moved you to **${targetChannel.name}**.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to move you. Check my permissions.', ephemeral: true });
    }
  }

  // --- /randomteams ---
  else if (commandName === 'randomteams') {
    const lobbyTeam1Option = interaction.options.getChannel('lobbyteam1');
    const team2Option      = interaction.options.getChannel('team2');

    const existing = lastSession.get(interaction.guildId);

    const lobbyTeam1Channel = lobbyTeam1Option || existing?.lobbyteam1;
    const team2Channel      = team2Option      || existing?.team2;

    if (!lobbyTeam1Channel || !team2Channel) {
      return interaction.reply({
        content: '❌ No saved channels found. Please provide #lobbyteam1 and #team2 the first time.',
        ephemeral: true,
      });
    }

    if (lobbyTeam1Channel.type !== 2 || team2Channel.type !== 2)
      return interaction.reply({ content: '❌ Both channels must be voice channels.', ephemeral: true });

    const spectatorRole = interaction.guild.roles.cache.find(r => r.name === 'Spectator');
    const members = [...lobbyTeam1Channel.members.values()].filter(m =>
      !spectatorRole || !m.roles.cache.has(spectatorRole.id)
    );

    if (members.length < 2)
      return interaction.reply({ content: '❌ Need at least 2 non-spectator people in the channel.', ephemeral: true });

    await interaction.deferReply();

    // Fisher-Yates shuffle
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }

    const half  = Math.floor(members.length / 2);
    const team1 = members.slice(0, half);
    const team2 = members.slice(half);

    await Promise.allSettled(team2.map(m => m.voice.setChannel(team2Channel)));

    lastSession.set(interaction.guildId, {
      lobbyteam1:   lobbyTeam1Channel,
      team2:        team2Channel,
      team1Members: team1.map(m => ({ userId: m.id, displayName: m.displayName })),
      team2Members: team2.map(m => ({ userId: m.id, displayName: m.displayName })),
    });

    const fmt = team => team.map(m => `• ${m.displayName}`).join('\n');

    await interaction.editReply(
      `🎮 Teams randomized!\n\n` +
      `**${lobbyTeam1Channel.name}** (${team1.length})\n${fmt(team1)}\n\n` +
      `**${team2Channel.name}** (${team2.length})\n${fmt(team2)}\n\n` +
      `*Use /done to move Team2 back. Use /win to record the result.*`
    );
  }

  // --- /done ---
  else if (commandName === 'done') {
    const session = lastSession.get(interaction.guildId);
    if (!session)
      return interaction.reply({ content: '❌ No session found. Run /randomteams first.', ephemeral: true });

    const { lobbyteam1: lobbyTeam1Channel, team2: team2Channel } = session;
    const members = [...team2Channel.members.values()];

    if (members.length === 0)
      return interaction.reply({ content: '❌ No one is in Team2.', ephemeral: true });

    await interaction.deferReply();

    const results = await Promise.allSettled(members.map(m => m.voice.setChannel(lobbyTeam1Channel)));
    const moved   = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;

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
      await interaction.reply({ content: '❌ Failed to update role. Make sure the bot role is above Spectator in server settings.', ephemeral: true });
    }
  }

  // --- /win ---
  else if (commandName === 'win') {
    const winningTeam = interaction.options.getString('team');
    const session     = lastSession.get(interaction.guildId);

    if (!session?.team1Members?.length || !session?.team2Members?.length) {
      return interaction.reply({
        content: '❌ No active session found. Run /randomteams first to record players, then use /win.',
        ephemeral: true,
      });
    }

    const { team1Members, team2Members } = session;

    const winners = winningTeam === 'team1' ? team1Members : team2Members;
    const losers  = winningTeam === 'team1' ? team2Members : team1Members;

    const data    = loadSR();
    const changes = applyElo(data, winners, losers);

    const winnerLines = winners.map(p => {
      const c = changes[p.userId];
      return `🏆 **${c.name}** ${c.delta} SR → **${c.newSR} SR**`;
    }).join('\n');

    const loserLines = losers.map(p => {
      const c = changes[p.userId];
      return `💀 **${c.name}** ${c.delta} SR → **${c.newSR} SR**`;
    }).join('\n');

    const winnerLabel = winningTeam === 'team1' ? 'Team 1' : 'Team 2';
    const loserLabel  = winningTeam === 'team1' ? 'Team 2' : 'Team 1';

    // Update rank roles for all players
    await Promise.allSettled([
      ...[...winners, ...losers].map(p =>
        updateRankRole(interaction.guild, p.userId, changes[p.userId].newSR)
      ),
    ]);

    await interaction.reply(
      `🎉 **${winnerLabel} wins!**\n\n` +
      `**Winners (${winnerLabel})**\n${winnerLines}\n\n` +
      `**Losers (${loserLabel})**\n${loserLines}\n\n` +
      `*SR data saved to \`sr_data.json\`.*`
    );
  }

  // --- /sr ---
  else if (commandName === 'sr') {
    const targetMember = interaction.options.getMember('user') ?? interaction.member;
    const data         = loadSR();
    const player       = data[targetMember.id];

    if (!player) {
      return interaction.reply({
        content: `❌ No SR data found for **${targetMember.displayName}**. They haven't played in a recorded session yet.`,
        ephemeral: true,
      });
    }

    const games   = player.wins + player.losses;
    const winrate = games > 0 ? ((player.wins / games) * 100).toFixed(1) : '0.0';
    const rank    = getRankForSR(player.sr);

    await interaction.reply(
      `📊 **${player.displayName}**\n` +
      `> Rank: **${rank.name}**\n` +
      `> SR: **${player.sr}**\n` +
      `> Wins: **${player.wins}** | Losses: **${player.losses}** | Games: **${games}**\n` +
      `> Winrate: **${winrate}%**`
    );
  }

  // --- /leaderboard ---
  else if (commandName === 'leaderboard') {
    const data    = loadSR();
    const players = Object.values(data)
      .filter(p => p.wins + p.losses > 0)
      .sort((a, b) => b.sr - a.sr)
      .slice(0, 10);

    if (players.length === 0) {
      return interaction.reply({ content: '❌ No SR data yet. Play some games first!', ephemeral: true });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = players.map((p, i) => {
      const games   = p.wins + p.losses;
      const winrate = ((p.wins / games) * 100).toFixed(1);
      const medal   = medals[i] || `**${i + 1}.**`;
      return `${medal} **${p.displayName}** — ${getRankForSR(p.sr).name} | ${p.sr} SR | ${p.wins}W/${p.losses}L (${winrate}%)`;
    });

    await interaction.reply(`🏆 **SR Leaderboard**\n\n${lines.join('\n')}`);
  }

  // --- /resetsr ---
  else if (commandName === 'resetsr') {
    const targetMember = interaction.options.getMember('user');
    const data         = loadSR();

    data[targetMember.id] = {
      displayName: targetMember.displayName,
      sr:          DEFAULT_SR,
      wins:        0,
      losses:      0,
    };

    saveSR(data);
    await updateRankRole(interaction.guild, targetMember.id, DEFAULT_SR);

    await interaction.reply(
      `🔄 Reset **${targetMember.displayName}**'s SR back to **${DEFAULT_SR}**.`
    );
  }
});

client.login(TOKEN);