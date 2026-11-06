import {
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits as I,
  Message,
  Options,
  PermissionFlagsBits,
<<<<<<< HEAD
=======
  Routes,
  TextDisplayBuilder,
  type APIGuildMember,
>>>>>>> 0f5ae5a84be2ae5f11d73d62b9fd41eb85964656
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
<<<<<<< HEAD
const emb = (t: string, d: string) => new EmbedBuilder().setTitle(t).setDescription(d.slice(0, 4000));
=======
>>>>>>> 0f5ae5a84be2ae5f11d73d62b9fd41eb85964656
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

<<<<<<< HEAD
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
  const say = (t: string, d: string) => m.reply({ embeds: [emb(t, d)], allowedMentions: { repliedUser: false, users: [], roles: [] } });
  try {
    const member = await m.guild.members.fetch({ user: m.author.id, cache: false });
    if (m.author.id !== OWNER_ID && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return void (await say('No permission', 'You need Manage Server or higher to use this bot.'));
    }
    if (!gid) {
      gid = m.guildId;
      await config.updateOne({ _id: 'guild' }, { $set: { id: gid } }, { upsert: true });
    } else if (gid !== m.guildId) {
      return void (await say('Error', 'This bot is bound to a different server.'));
    }
    await say(...(await cmd(m, args)));
  } catch (e) {
    console.error(e);
    await say('Error', (e as Error).message).catch(() => {});
=======
// ---------- Command layer: one implementation, reachable via slash and prefix ----------

const PREFIX = process.env.PREFIX ?? '!';
const GREEN = 0x57f287;

type View = { title: string; text: string; color?: number };
const ok = (title: string, text: string): View => ({ title, text, color: GREEN });
const fail = (title: string, text: string): View => ({ title, text });
const info = (title: string, text: string): View => ({ title, text });

// Components V2 container: a clean embed-style card with a coloured accent bar.
// Only success gets a colour (green); everything else has no accent bar.
const card = (v: View) => {
  const c = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${v.title}\n${v.text}`),
  );
  return v.color === undefined ? c : c.setAccentColor(v.color);
};

interface Ctx {
  guildId: string | null;
  userId: string;
  canManage: boolean;
  users: string[];
  roles: string[];
  channel?: string;
}

async function targets(c: Ctx) {
  const ids = new Set(c.users);
  for (const r of c.roles) (await roleIds(r)).forEach((id) => ids.add(id));
  return [...ids];
}

const run: Record<string, (c: Ctx) => Promise<View>> = {
  async syncvouches(c) {
    const ch = c.channel ? await bot.channels.fetch(c.channel).catch(() => null) : null;
    if (!ch?.isTextBased()) return fail('Sync vouches', 'Provide a valid text channel.');
    await config.updateOne({ _id: 'vouchChannel' }, { $set: { id: ch.id } }, { upsert: true });
    vc = ch.id;
    const n = await syncVouches(ch);
    return ok('Sync vouches', `${n} messages synced from ${ch}.`);
  },

  async syncprofile() {
    const n = await scan();
    return ok('Sync profile', `${tracked.size} scanned, ${n} updated.`);
  },

  async addmember(c) {
    const ids = await targets(c);
    if (!ids.length) return fail('Add member', 'Provide a user or a role.');
    let n = 0;
    for (const id of ids) {
      const r = await users.updateOne(
        { _id: id },
        { $setOnInsert: { addedAt: new Date(), addedBy: c.userId } },
        { upsert: true },
      );
      n += r.upsertedCount;
      tracked.add(id);
      await profile(id)
        .then((p) => users.updateOne({ _id: id }, { $set: { ...p, syncedAt: new Date() } }))
        .catch(() => {});
    }
    return ok('Add member', `${n} added, ${ids.length - n} already tracked.`);
  },

  async removeuser(c) {
    const ids = await targets(c);
    if (!ids.length) return fail('Remove user', 'Provide a user or a role.');
    const { deletedCount } = await users.deleteMany({ _id: { $in: ids } });
    ids.forEach((id) => tracked.delete(id));
    return ok('Remove user', `${deletedCount} removed.`);
  },

  async listusers() {
    if (!tracked.size) return info('Tracked users', 'No users are being tracked.');
    let text = '';
    let shown = 0;
    for (const id of tracked) {
      const line = `<@${id}>\n`;
      if (text.length + line.length > 3500) break;
      text += line;
      shown++;
    }
    const more = tracked.size - shown;
    return info(`Tracked users (${tracked.size})`, text + (more ? `…and ${more} more` : ''));
  },

  async help() {
    const p = PREFIX;
    return info(
      'Help',
      [
        'Use `/command`, `' + p + 'command` or `@bot command`.',
        '',
        '`addmember <user|role>`: track a user, or every member of a role',
        '`removeuser <user|role>`: stop tracking a user or role',
        '`listusers`: list tracked users',
        '`resetusers`: stop tracking everyone',
        '`syncvouches <#channel>`: sync vouch messages',
        '`syncprofile`: refresh tracked profiles',
      ].join('\n'),
    );
  },

  async resetusers() {
    const { deletedCount } = await users.deleteMany({});
    tracked.clear();
    return ok('Reset users', `${deletedCount} tracked users cleared.`);
  },
};

// Shared gatekeeping + execution. Returns the view to send back.
// Returns null when the caller isn't allowed: the bot stays silent.
async function dispatch(name: string, c: Ctx): Promise<View | null> {
  if (!c.canManage) return null;
  if (name === 'help') return run.help(c);
  if (!c.guildId) return fail('Error', 'Use this in a server.');
  try {
    if (!gid) {
      gid = c.guildId;
      await config.updateOne({ _id: 'guild' }, { $set: { id: gid } }, { upsert: true });
    } else if (gid !== c.guildId) {
      return fail('Error', 'This bot is bound to a different server.');
    }
    return await run[name](c);
  } catch (e) {
    logErr(`dispatch ${name}`, e);
    return fail('Error', (e as Error).message);
  }
}

// Bot owner, server owner, or anyone with Manage Server / Administrator.
// Returns the decision plus the reason so every outcome can be logged.
async function allowed(
  id: string,
  guildId: string | null,
  perms?: { has(p: bigint): boolean } | null,
): Promise<{ ok: boolean; why: string }> {
  if (id === OWNER_ID) return { ok: true, why: 'bot owner' };
  if (!perms) return guildId ? ownerCheck(id, guildId, 'no perms resolved') : { ok: false, why: 'dm, not bot owner' };
  if (perms.has(PermissionFlagsBits.Administrator)) return { ok: true, why: 'administrator' };
  if (perms.has(PermissionFlagsBits.ManageGuild)) return { ok: true, why: 'manage server' };
  return guildId ? ownerCheck(id, guildId, 'lacks manage server/admin') : { ok: false, why: 'dm, not bot owner' };
}

async function ownerCheck(id: string, guildId: string, prior: string) {
  try {
    const g = await bot.guilds.fetch(guildId);
    if (g.ownerId === id) return { ok: true, why: 'server owner' };
    return { ok: false, why: `${prior}; not server owner (owner is ${g.ownerId})` };
  } catch (e) {
    logErr('allowed', e);
    return { ok: false, why: `${prior}; guild fetch failed` };
  }
}

// message.member reads the member cache, which is disabled here, so fetch it (no caching).
async function memberPerms(m: Message) {
  if (!m.guild) return null;
  try {
    return (await m.guild.members.fetch({ user: m.author.id, cache: false })).permissions;
  } catch (e) {
    logErr('memberPerms', e);
    return null;
  }
}

async function finish(name: string, c: Omit<Ctx, 'canManage'>, a: { ok: boolean }) {
  return a.ok ? dispatch(name, { ...c, canManage: true }) : null;
}

// Slash
bot.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.isChatInputCommand() || !Object.hasOwn(run, i.commandName)) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    const v = await finish(
      i.commandName,
      {
        guildId: i.guildId,
        userId: i.user.id,
        users: [i.options.getUser('user')?.id].filter((x): x is string => !!x),
        roles: [i.options.getRole('role')?.id].filter((x): x is string => !!x),
        channel: i.options.getChannel('channel')?.id,
      },
      await allowed(i.user.id, i.guildId, i.memberPermissions),
    );
    if (!v) return void (await i.deleteReply().catch((e) => logErr('deleteReply', e)));
    await i.editReply({ components: [card(v)], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    logErr(`slash ${i.isChatInputCommand() ? i.commandName : ''}`, e);
  }
});

// Prefix and @mention
bot.on(Events.MessageCreate, async (m) => {
  try {
    if (m.author.bot) return;
    // Triggered by "<prefix>cmd" or "@bot cmd"
    const mention = new RegExp(`^<@!?${bot.user?.id}>\\s*`).exec(m.content);
    const body = mention
      ? m.content.slice(mention[0].length)
      : m.content.startsWith(PREFIX)
        ? m.content.slice(PREFIX.length)
        : null;
    if (body === null) return;
    const [cmd, ...args] = body.trim().split(/\s+/);
    const name = cmd?.toLowerCase();
    if (!name || !Object.hasOwn(run, name)) return;

    const ids = (re: RegExp) => args.map((a) => a.match(re)?.[1]).filter((x): x is string => !!x);
    const v = await finish(
      name,
      {
        guildId: m.guildId,
        userId: m.author.id,
        users: [...ids(/^<@!?(\d+)>$/), ...ids(/^(\d{17,20})$/)],
        roles: ids(/^<@&(\d+)>$/),
        channel: ids(/^<#(\d+)>$/)[0],
      },
      await allowed(m.author.id, m.guildId, await memberPerms(m)),
    );
    if (!v) return;
    await m.reply({
      components: [card(v)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (e) {
    logErr('message', e);
>>>>>>> 0f5ae5a84be2ae5f11d73d62b9fd41eb85964656
  }
});

const timers = new Map<string, NodeJS.Timeout>();

const debounce = (id: string, fn: () => Promise<unknown>) => {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
<<<<<<< HEAD
      fn().catch((e) => console.error(`live member ${id}:`, e.message));
=======
      refresh(id).catch((e) => logErr(`live profile ${id}`, e));
>>>>>>> 0f5ae5a84be2ae5f11d73d62b9fd41eb85964656
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
<<<<<<< HEAD
  reconcile().catch(console.error);
  setInterval(() => reconcile().catch(console.error), 30 * 60_000);
=======
  setInterval(() => scan().catch((e) => logErr('scan', e)), 30 * 60_000);
>>>>>>> 0f5ae5a84be2ae5f11d73d62b9fd41eb85964656
});

await bot.login(process.env.DISCORD_TOKEN);
