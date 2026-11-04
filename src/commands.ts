import { SlashCommandBuilder } from 'discord.js';

// Commands are visible to everyone; access is enforced at runtime in index.ts.
// Each is also available with a text prefix (default "!"), e.g. !addmember @user
const target = (name: string, desc: string, roleDesc: string) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(desc)
    .addUserOption((o) => o.setName('user').setDescription('User'))
    .addRoleOption((o) => o.setName('role').setDescription(roleDesc));

export const commands = [
  new SlashCommandBuilder()
    .setName('syncvouches')
    .setDescription('Sync all vouch messages to the database')
    .addChannelOption((o) => o.setName('channel').setDescription('Vouch channel').setRequired(true)),
  new SlashCommandBuilder()
    .setName('syncprofile')
    .setDescription('Sync tracked user profiles to the database'),
  target('addmember', 'Track a user, or every member of a role', 'Track all members of this role'),
  target('removeuser', 'Stop tracking a user, or every member of a role', 'Remove all members of this role'),
  new SlashCommandBuilder().setName('listusers').setDescription('List all tracked users'),
  new SlashCommandBuilder().setName('resetusers').setDescription('Stop tracking all users'),
].map((c) => c.toJSON());
