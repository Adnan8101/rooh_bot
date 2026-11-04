import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

await new REST()
  .setToken(process.env.DISCORD_TOKEN!)
  .put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: commands });

console.log(`Deployed ${commands.length} commands`);
