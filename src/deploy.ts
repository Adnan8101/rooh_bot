import { REST, Routes } from 'discord.js';

// The bot now uses "!" prefix commands; this clears the old slash commands from Discord.
await new REST().setToken(process.env.DISCORD_TOKEN!).put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: [] });

console.log('Cleared slash commands');
