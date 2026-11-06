import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

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
  new SlashCommandBuilder().setName('help').setDescription('Show all commands'),
]
  // Hidden from non-admins in Discord's UI; runtime checks in index.ts are the real gate.
  .map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).toJSON());
