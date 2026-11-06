import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits as I,
  Message,
  Options,
  PermissionFlagsBits,
  type TextBasedChannel,
} from 'discord.js';
import { config, roles, users, vouches } from './db.js';

const PREFIX = '!';
// Website tiers, highest first. Must match TIERS in website/app/team/data.ts.
const TIERS = ['Owner', 'Imposter', 'Malkin', 'Co Owner', 'Manager', 'Head Mod', 'Staff Team'];

const NO_CACHE = [
  'MessageManager', 'UserManager', 'GuildMemberManager', 'PresenceManager', 'ReactionManager',
  'ReactionUserManager', 'VoiceStateManager', 'GuildEmojiManager', 'GuildStickerManager',
  'GuildScheduledEventManager', 'StageInstanceManager', 'ThreadManager', 'ThreadMemberManager',
  'GuildInviteManager', 'GuildBanManager', 'AutoModerationRuleManager', 'BaseGuildEmojiManager',
  'DMMessageManager', 'GuildForumThreadManager', 'GuildMessageManager', 'GuildTextThreadManager',
  'ApplicationCommandManager', 'EntitlementManager', 'SubscriptionManager',
];

const bot = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildMessages, I.MessageContent],
  makeCache: Options.cacheWithLimits(Object.fromEntries(NO_CACHE.map((k) => [k, 0]))),
});

const OWNER_ID = '929297205796417597';
const emb = (t: string, d: string) => new EmbedBuilder().setTitle(t).setDescription(d.slice(0, 4000));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const logErr = (scope: string, e: unknown) => console.error(`[${scope}]`, e instanceof Error ? e.message : e);

// Guild is stored in Mongo (config.guild); it is bound by the first command run in a server.
let gid: string | undefined = (await config.findOne({ _id: 'guild' }))?.id;
let vc: string | undefined = (await config.findOne({ _id: 'vouchChannel' }))?.id;
const tracked = new Set<string>((await users.find({}, { projection: { _id: 1 } }).toArray()).map((u) => u._id));
// Discord role id -> website tier
const roleMap = new Map<string, string>((await roles.find().toArray()).map((r) => [r._id, r.tier]));

const guild = () => (gid ? bot.guilds.cache.get(gid) : undefined);

async function profile(id: string) {
  const u = await bot.users.fetch(id, { force: true });
  const m = await guild()?.members.fetch({ user: id, cache: false }).catch(() => null);
  return {
    username: u.username,
    globalName: u.globalName,
    displayName: m?.displayName ?? u.displayName,
    bot: u.bot,
    avatar: (m ?? u).displayAvatarURL({ size: 512 }),
    banner: u.bannerURL({ size: 1024 }) ?? null,
    accentColor: u.hexAccentColor ?? null,
    createdAt: u.createdAt,
    joinedAt: m?.joinedAt ?? null,
    roles: m ? m.roles.cache.filter((r) => r.id !== gid).map((r) => ({ id: r.id, name: r.name })) : [],
  };
}

const save = (id: string) =>
  profile(id)
    .then((p) => users.updateOne({ _id: id }, { $set: { ...p, syncedAt: new Date() } }))
    .catch((e) => console.error(`profile ${id}:`, e.message));

async function refresh(id: string) {
  const doc = await users.findOne({ _id: id });
  if (!doc) return false;
  const { _id, addedAt, addedBy, syncedAt, manualTier, teamRole, ...old } = doc;
  const next = await profile(id);
  if (same(old, next)) return false;
  await users.updateOne({ _id }, { $set: { ...next, syncedAt: new Date() } });
  return true;
}

async function scan() {
  let n = 0;
  for (const id of tracked) {
    try {
      if (await refresh(id)) n++;
    } catch (e) {
      logErr(`profile ${id}`, e);
    }
  }
  return n;
}

/** Highest tier a user qualifies for: their own (from !adduser) or any linked role they hold. */
function tierOf(u: { manualTier?: string; roles?: { id: string }[] }) {
  const ranks = [u.manualTier, ...(u.roles ?? []).map((r) => roleMap.get(r.id))]
    .map((t) => (t ? TIERS.indexOf(t) : -1))
    .filter((i) => i >= 0);
  return ranks.length ? TIERS[Math.min(...ranks)] : undefined;
}

// Users who are only listed because of a role (addedBy 'role', no own tier) follow that role.
const roleOnly = { addedBy: 'role', manualTier: { $exists: false } };

/** A member's roles changed (or they left): add them if they now hold a linked role, drop them if not. */
async function checkMember(id: string, roleIds: string[] | null, isBot = false) {
  const linked = !isBot && !!roleIds?.some((r) => roleMap.has(r));
  if (linked && !tracked.has(id)) {
    await users.updateOne({ _id: id }, { $setOnInsert: { addedAt: new Date(), addedBy: 'role' } }, { upsert: true });
    tracked.add(id);
    await save(id);
  } else if (!linked && tracked.has(id)) {
    const { deletedCount } = await users.deleteOne({ _id: id, ...roleOnly });
    if (deletedCount) tracked.delete(id);
    else await refresh(id);
  } else if (linked) {
    await refresh(id);
  }
}

/** Full pass over the server: make the role-based part of the team match Discord exactly. */
async function reconcile() {
  const g = guild();
  if (!g) return { added: 0, removed: 0 };
  const members = await g.members.fetch();
  const want = members.filter((m) => !m.user.bot && m.roles.cache.some((r) => roleMap.has(r.id)));
  let added = 0;
  for (const m of want.values()) {
    if (tracked.has(m.id)) continue;
    await users.updateOne({ _id: m.id }, { $setOnInsert: { addedAt: new Date(), addedBy: 'role' } }, { upsert: true });
    tracked.add(m.id);
    await save(m.id);
    added++;
  }
  const stale = await users.find({ ...roleOnly, _id: { $nin: [...want.keys()] } }, { projection: { _id: 1 } }).toArray();
  if (stale.length) await users.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
  for (const u of stale) tracked.delete(u._id);
  await scan();
  return { added, removed: stale.length };
}

const vouch = (m: Message) => ({
  guildId: m.guildId,
  channelId: m.channelId,
  content: m.content,
  url: m.url,
  createdAt: m.createdAt,
  editedAt: m.editedAt,
  attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, url: a.url, type: a.contentType })),
  author: {
    id: m.author.id,
    username: m.author.username,
    globalName: m.author.globalName,
    displayName: m.member?.displayName ?? m.author.displayName,
    avatar: m.author.displayAvatarURL({ size: 256 }),
    bot: m.author.bot,
  },
  syncedAt: new Date(),
});

async function syncVouches(ch: TextBasedChannel) {
  let before: string | undefined;
  let n = 0;
  for (;;) {
    const b = await ch.messages.fetch({ limit: 100, before, cache: false });
    if (!b.size) return n;
    await vouches.bulkWrite(
      b.map((m) => ({ updateOne: { filter: { _id: m.id }, update: { $set: vouch(m) }, upsert: true } })),
      { ordered: false },
    );
    n += b.size;
    before = b.last()!.id;
  }
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const tier = (s: string) => TIERS.find((t) => key(t) === key(s));
const userId = (a = '') => a.match(/^<@!?(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
const roleId = (a = '') => a.match(/^<@&(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
const TIER_LIST = TIERS.map((t) => `\`${t}\``).join(', ');

const HELP = [
  `\`${PREFIX}adduser @user <tier>\` - put a member on the website in a tier`,
  `\`${PREFIX}removeuser @user\` - take a member off the website`,
  `\`${PREFIX}addrole @role <tier>\` - everyone with this role goes in that tier`,
  `\`${PREFIX}removerole @role\` - unlink a role`,
  `\`${PREFIX}listusers\` - everyone on the website, by tier`,
  `\`${PREFIX}listroles\` - linked roles and their tiers`,
  `\`${PREFIX}resetdata confirm\` - wipe all users and role links`,
  `\`${PREFIX}syncvouches #channel\` - sync all vouch messages`,
  `\`${PREFIX}syncprofile\` - refresh profiles and role members`,
  '',
  `Tiers, highest first: ${TIER_LIST}`,
  'Someone who qualifies for several tiers is shown once, in the highest.',
].join('\n');

// Each command returns [title, description] for the reply embed.
const run: Record<string, (m: Message, args: string[]) => Promise<[string, string]>> = {
  async adduser(m, [who, ...rest]) {
    const id = userId(who);
    const t = tier(rest.join(' '));
    if (!id || !t) return ['Add user', `Usage: \`${PREFIX}adduser @user <tier>\`\nTiers: ${TIER_LIST}`];
    const r = await users.updateOne(
      { _id: id },
      { $set: { manualTier: t, addedBy: m.author.id }, $setOnInsert: { addedAt: new Date() } },
      { upsert: true },
    );
    tracked.add(id);
    await save(id);
    const shown = tierOf((await users.findOne({ _id: id })) ?? {});
    const note = shown && shown !== t ? `\nShown as **${shown}** on the website - a role of theirs ranks higher.` : '';
    return ['Add user', `<@${id}> ${r.upsertedCount ? 'added as' : 'is now'} **${t}**.${note}`];
  },

  async removeuser(m, [who]) {
    const id = userId(who);
    if (!id) return ['Remove user', `Usage: \`${PREFIX}removeuser @user\``];
    const doc = await users.findOne({ _id: id });
    if (!doc) return ['Remove user', `<@${id}> is not on the website.`];
    const viaRole = (doc.roles ?? []).find((r: { id: string }) => roleMap.has(r.id));
    if (viaRole) {
      await users.updateOne({ _id: id }, { $unset: { manualTier: '' }, $set: { addedBy: 'role' } });
      return ['Remove user', `Removed <@${id}>'s own tier, but they still hold <@&${viaRole.id}> (**${roleMap.get(viaRole.id)}**), so they stay listed. Use \`${PREFIX}removerole\` or take the role away.`];
    }
    await users.deleteOne({ _id: id });
    tracked.delete(id);
    return ['Remove user', `<@${id}> removed from the website.`];
  },

  async addrole(m, [r, ...rest]) {
    const id = roleId(r);
    const t = tier(rest.join(' '));
    const role = id ? await m.guild!.roles.fetch(id).catch(() => null) : null;
    if (!role || !t) return ['Add role', `Usage: \`${PREFIX}addrole @role <tier>\`\nTiers: ${TIER_LIST}`];
    await roles.updateOne({ _id: role.id }, { $set: { name: role.name, tier: t, addedBy: m.author.id, addedAt: new Date() } }, { upsert: true });
    roleMap.set(role.id, t);
    const { added } = await reconcile();
    return ['Add role', `Everyone with ${role} now shows as **${t}** on the website.\n${added} new member${added === 1 ? '' : 's'} added.`];
  },

  async removerole(m, [r]) {
    const id = roleId(r);
    if (!id) return ['Remove role', `Usage: \`${PREFIX}removerole @role\``];
    const { deletedCount } = await roles.deleteOne({ _id: id });
    roleMap.delete(id);
    if (!deletedCount) return ['Remove role', `<@&${id}> is not linked.`];
    const { removed } = await reconcile();
    return ['Remove role', `<@&${id}> unlinked. ${removed} member${removed === 1 ? '' : 's'} who were only listed through it removed.`];
  },

  async listusers() {
    const list = await users.find({ bot: { $ne: true } }, { projection: { manualTier: 1, roles: 1 } }).toArray();
    const groups = [...TIERS, undefined].map((t) => {
      const who = list.filter((u) => tierOf(u) === t);
      return who.length ? `**${t ?? 'No tier (hidden)'}** (${who.length})\n${who.map((u) => `<@${u._id}>${u.manualTier ? '' : ' · via role'}`).join(', ')}` : '';
    });
    return ['Users', groups.filter(Boolean).join('\n\n') || 'Nobody yet.'];
  },

  async listroles() {
    const list = [...roleMap].sort((a, b) => TIERS.indexOf(a[1]) - TIERS.indexOf(b[1]));
    return ['Roles', list.map(([id, t]) => `<@&${id}> → **${t}**`).join('\n') || `No roles linked. Use \`${PREFIX}addrole @role <tier>\`.`];
  },

  async resetdata(m, [confirm]) {
    if (confirm !== 'confirm') return ['Reset data', `This deletes every website user and role link (vouches are kept).\nRun \`${PREFIX}resetdata confirm\` to do it.`];
    const [u, r] = await Promise.all([users.deleteMany({}), roles.deleteMany({})]);
    tracked.clear();
    roleMap.clear();
    return ['Reset data', `Deleted ${u.deletedCount} users and ${r.deletedCount} role links.`];
  },

  async syncvouches(m, [chan]) {
    const id = chan?.match(/^<#(\d+)>$/)?.[1] ?? chan;
    const ch = id ? await bot.channels.fetch(id).catch(() => null) : null;
    if (!ch?.isTextBased()) return ['Sync vouches', `Usage: \`${PREFIX}syncvouches #channel\``];
    await config.updateOne({ _id: 'vouchChannel' }, { $set: { id: ch.id } }, { upsert: true });
    vc = ch.id;
    return ['Sync vouches', `${await syncVouches(ch)} messages synced from ${ch}.`];
  },

  async syncprofile() {
    const { added, removed } = await reconcile();
    return ['Sync profile', `${tracked.size} users checked. ${added} added, ${removed} removed through roles.`];
  },

  async help() {
    return ['ROOH bot', HELP];
  },
};

bot.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.inGuild() || !m.content.startsWith(PREFIX)) return;
  const [name, ...args] = m.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = run[name?.toLowerCase()];
  if (!cmd) return;
  const quiet = { repliedUser: false, users: [], roles: [] };
  // Embed reply first; if the channel blocks embeds or replies, fall back to plain text so the bot never goes silent.
  const say = async (t: string, d: string) => {
    try {
      await m.reply({ embeds: [emb(t, d)], allowedMentions: quiet });
    } catch (e) {
      logErr(`reply ${name}`, e);
      await m.channel.send({ content: `**${t}**\n${d}`.slice(0, 2000), allowedMentions: quiet }).catch((e2) => logErr(`send ${name}`, e2));
    }
  };
  console.log(`[cmd] ${m.author.tag} (${m.author.id}) ran !${name} in ${m.guild.name}`);
  try {
    await m.channel.sendTyping().catch(() => {});
    // The bot owner is always allowed; everyone else needs Manage Server.
    if (m.author.id !== OWNER_ID) {
      const member = await m.guild.members.fetch({ user: m.author.id, cache: false });
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return void (await say('No permission', 'You need Manage Server or higher to use this bot.'));
      }
    }
    if (!gid) {
      gid = m.guildId;
      await config.updateOne({ _id: 'guild' }, { $set: { id: gid } }, { upsert: true });
    } else if (gid !== m.guildId) {
      return void (await say('Error', 'This bot is bound to a different server.'));
    }
    await say(...(await cmd(m, args)));
  } catch (e) {
    logErr(`cmd ${name}`, e);
    await say('Error', (e as Error).message);
  }
});

const timers = new Map<string, NodeJS.Timeout>();

const debounce = (id: string, fn: () => Promise<unknown>) => {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      fn().catch((e) => logErr(`live member ${id}`, e));
    }, 2000),
  );
};

bot.on(Events.Raw, async ({ t, d }: { t: string; d: any }) => {
  try {
    if (t === 'GUILD_MEMBER_UPDATE' || t === 'GUILD_MEMBER_ADD') {
      if (d.guild_id === gid) debounce(d.user.id, () => checkMember(d.user.id, d.roles, d.user.bot));
      return;
    }
    if (t === 'GUILD_MEMBER_REMOVE') {
      if (d.guild_id === gid) debounce(d.user.id, () => checkMember(d.user.id, null));
      return;
    }
    if (d?.channel_id !== vc) return;
    if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
      const ch = (await bot.channels.fetch(d.channel_id)) as TextBasedChannel;
      const m = await ch.messages.fetch({ message: d.id, cache: false });
      await vouches.updateOne({ _id: d.id }, { $set: vouch(m) }, { upsert: true });
    } else if (t === 'MESSAGE_DELETE') {
      await vouches.deleteOne({ _id: d.id });
    } else if (t === 'MESSAGE_DELETE_BULK') {
      await vouches.deleteMany({ _id: { $in: d.ids } });
    }
  } catch (e) {
    logErr(`live ${t}`, e);
  }
});

bot.once(Events.ClientReady, (c) => {
  console.log(`Ready as ${c.user.tag}`);
  reconcile().catch((e) => logErr("reconcile", e));
  setInterval(() => reconcile().catch((e) => logErr("reconcile", e)), 30 * 60_000);
});

await bot.login(process.env.DISCORD_TOKEN);
