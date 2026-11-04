import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const perm = PermissionFlagsBits.ManageGuild;

const target = (name: string, desc: string, roleDesc: string) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(desc)
    .addUserOption((o) => o.setName('user').setDescription('User'))
    .addRoleOption((o) => o.setName('role').setDescription(roleDesc))
    .setDefaultMemberPermissions(perm);

export const commands = [
  new SlashCommandBuilder()
    .setName('sync-vouches')
    .setDescription('Sync all vouch messages to the database')
    .addChannelOption((o) => o.setName('channel').setDescription('Vouch channel').setRequired(true))
    .setDefaultMemberPermissions(perm),
  new SlashCommandBuilder()
    .setName('sync-profile')
    .setDescription('Sync tracked user profiles to the database')
    .setDefaultMemberPermissions(perm),
  target('add-user', 'Track a user, or every member of a role', 'Track all members of this role'),
  target('remove-user', 'Stop tracking a user, or every member of a role', 'Remove all members of this role'),
].map((c) => c.toJSON());
