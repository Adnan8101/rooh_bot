import {
  Client,
  ContainerBuilder,
  Events,
  type Guild,
  type GuildMember,
  GatewayIntentBits as I,
  Message,
  MessageFlags,
  Options,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
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
/**
 * Every member of the server, read over REST 1000 at a time. (Fetching through the gateway is
 * limited to about once per 30s and was failing with "opcode 8 was rate limited".)
 */
async function allMembers(g: Guild) {
  const out = new Map<string, GuildMember>();
  let after = '0';
  for (;;) {
    const page = await g.members.list({ limit: 1000, after, cache: false });
    for (const [id, m] of page) out.set(id, m);
    if (page.size < 1000) return out;
    after = [...page.keys()].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  }
}

// Runs one reconcile at a time; overlapping calls queue up instead of colliding.
let queue: Promise<unknown> = Promise.resolve();
function reconcile() {
  const next = queue.then(reconcileNow);
  queue = next.catch(() => {});
  return next;
}

async function reconcileNow() {
  const g = guild();
  if (!g) return { added: 0, removed: 0 };
  const all = await allMembers(g);
  const want = new Map([...all].filter(([, m]) => !m.user.bot && m.roles.cache.some((r) => roleMap.has(r.id))));
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
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- Reply UI ----------
// Every reply is one Components V2 container: title, sections split by dividers, small footer.
// No accent colour by default; a green bar for success, a red bar for errors.

const GREEN = 0x57f287;
const RED = 0xed4245;

type View = { title: string; sections: string[]; tone?: 'ok' | 'error'; footer?: string };

const info = (title: string, ...sections: string[]): View => ({ title, sections });
const ok = (title: string, ...sections: string[]): View => ({ title, sections, tone: 'ok' });
const fail = (title: string, ...sections: string[]): View => ({ title, sections, tone: 'error' });
const usage = (title: string, syntax: string, ...more: string[]) => fail(title, `**Usage**\n\`${PREFIX}${syntax}\``, ...more);
const tierHelp = `**Tiers**, highest first\n${TIERS.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;

// A V2 message holds 4000 characters of text across all its text components.
function fit(v: View) {
  let left = 3800 - v.title.length;
  return v.sections.flatMap((s) => {
    if (left <= 0) return [];
    const cut = s.length > left ? `${s.slice(0, left - 20)}\n-# ...and more` : s;
    left -= cut.length;
    return [cut];
  });
}

const text = (s: string) => new TextDisplayBuilder().setContent(s);
const divider = (line = true) => new SeparatorBuilder().setDivider(line).setSpacing(SeparatorSpacingSize.Small);

function render(v: View) {
  const c = new ContainerBuilder();
  if (v.tone) c.setAccentColor(v.tone === 'ok' ? GREEN : RED);
  c.addTextDisplayComponents(text(`## ${v.title}`));
  for (const s of fit(v)) c.addSeparatorComponents(divider()).addTextDisplayComponents(text(s));
  c.addSeparatorComponents(divider(false)).addTextDisplayComponents(text(`-# ${v.footer ?? `ROOH  |  ${PREFIX}help for every command`}`));
  return c;
}

const cmdLine = (syntax: string, what: string) => `\`${PREFIX}${syntax}\`\n-# ${what}`;

const HELP: View = {
  title: 'ROOH bot',
  sections: [
    'Controls who appears on the ROOH website and keeps vouches in sync with Discord.',
    ['**Website users**', cmdLine('adduser @user <tier>', 'Put a member on the website in a tier'), cmdLine('removeuser @user', 'Take a member off the website'), cmdLine('listusers', 'Everyone on the website, by tier')].join('\n'),
    ['**Roles**', cmdLine('addrole @role <tier>', 'Everyone with this role goes in that tier'), cmdLine('removerole @role', 'Unlink a role'), cmdLine('listroles', 'Linked roles and their tiers')].join('\n'),
    ['**Sync**', cmdLine('syncvouches #channel', 'Sync every message in the vouch channel'), cmdLine('syncprofile', 'Refresh profiles and role members')].join('\n'),
    ['**Data**', cmdLine('resetdata confirm', 'Delete all website users and role links. Vouches are kept')].join('\n'),
    `${tierHelp}\n-# Someone who qualifies for several tiers is shown once, in the highest.`,
  ],
};

// ---------- Commands ----------

const run: Record<string, (m: Message, args: string[]) => Promise<View>> = {
  async adduser(m, [who, ...rest]) {
    const id = userId(who);
    const t = tier(rest.join(' '));
    if (!id || !t) return usage('Add user', 'adduser @user <tier>', tierHelp);
    const r = await users.updateOne(
      { _id: id },
      { $set: { manualTier: t, addedBy: m.author.id }, $setOnInsert: { addedAt: new Date() } },
      { upsert: true },
    );
    tracked.add(id);
    await save(id);
    const shown = tierOf((await users.findOne({ _id: id })) ?? {});
    return ok(
      r.upsertedCount ? 'User added' : 'Tier updated',
      `<@${id}> ${r.upsertedCount ? 'is now on the website as' : 'is now'} **${t}**.`,
      ...(shown && shown !== t ? [`**Shown as ${shown}**\n-# One of their linked roles ranks higher, so the website places them there.`] : []),
    );
  },

  async removeuser(m, [who]) {
    const id = userId(who);
    if (!id) return usage('Remove user', 'removeuser @user');
    const doc = await users.findOne({ _id: id });
    if (!doc) return fail('Remove user', `<@${id}> is not on the website.`);
    const viaRole = (doc.roles ?? []).find((r: { id: string }) => roleMap.has(r.id));
    if (viaRole) {
      await users.updateOne({ _id: id }, { $unset: { manualTier: '' }, $set: { addedBy: 'role' } });
      return fail(
        'Still listed',
        `Removed <@${id}>'s own tier, but they hold <@&${viaRole.id}>, which is linked to **${roleMap.get(viaRole.id)}**.`,
        `-# Unlink it with \`${PREFIX}removerole\` or take the role away to remove them completely.`,
      );
    }
    await users.deleteOne({ _id: id });
    tracked.delete(id);
    return ok('User removed', `<@${id}> is no longer on the website.`);
  },

  async addrole(m, [r, ...rest]) {
    const id = roleId(r);
    const t = tier(rest.join(' '));
    const role = id ? await m.guild!.roles.fetch(id).catch(() => null) : null;
    if (!role || !t) return usage('Add role', 'addrole @role <tier>', tierHelp);
    await roles.updateOne({ _id: role.id }, { $set: { name: role.name, tier: t, addedBy: m.author.id, addedAt: new Date() } }, { upsert: true });
    roleMap.set(role.id, t);
    const { added } = await reconcile();
    return ok('Role linked', `Everyone with ${role} now shows as **${t}** on the website.`, `**${plural(added, 'new member')}** added\n-# Members gaining or losing this role update automatically.`);
  },

  async removerole(m, [r]) {
    const id = roleId(r);
    if (!id) return usage('Remove role', 'removerole @role');
    const { deletedCount } = await roles.deleteOne({ _id: id });
    roleMap.delete(id);
    if (!deletedCount) return fail('Remove role', `<@&${id}> is not linked to a tier.`);
    const { removed } = await reconcile();
    return ok('Role unlinked', `<@&${id}> no longer places anyone on the website.`, `**${plural(removed, 'member')}** removed\n-# Only people who were listed through this role alone.`);
  },

  async listusers() {
    const list = await users.find({ bot: { $ne: true } }, { projection: { manualTier: 1, roles: 1 } }).toArray();
    const sections = [...TIERS, undefined].flatMap((t) => {
      const who = list.filter((u) => tierOf(u) === t);
      if (!who.length) return [];
      const names = who.map((u) => `<@${u._id}>${u.manualTier ? '' : ' (role)'}`).join('  ');
      return [`**${t ?? 'No tier - hidden'}**  -  ${who.length}\n${names}`];
    });
    const shown = list.filter((u) => tierOf(u)).length;
    return { ...info('Website users', ...(sections.length ? sections : ['Nobody yet. Add someone with `!adduser` or link a role with `!addrole`.'])), footer: `${plural(shown, 'person')} on the website  |  (role) = listed through a linked role` };
  },

  async listroles() {
    const list = [...roleMap].sort((a, b) => TIERS.indexOf(a[1]) - TIERS.indexOf(b[1]));
    if (!list.length) return info('Linked roles', `No roles linked yet.\n-# Use \`${PREFIX}addrole @role <tier>\`.`);
    const byTier = TIERS.flatMap((t) => {
      const rs = list.filter(([, x]) => x === t);
      return rs.length ? [`**${t}**\n${rs.map(([id]) => `<@&${id}>`).join('  ')}`] : [];
    });
    return { ...info('Linked roles', ...byTier), footer: `${plural(list.length, 'role')} linked` };
  },

  async resetdata(m, [confirm]) {
    if (confirm !== 'confirm')
      return fail('Reset data', 'This deletes **every website user and role link**. Vouches are kept.', `Run \`${PREFIX}resetdata confirm\` to go ahead.`);
    const [u, r] = await Promise.all([users.deleteMany({}), roles.deleteMany({})]);
    tracked.clear();
    roleMap.clear();
    return ok('Data reset', `Deleted **${plural(u.deletedCount, 'user')}** and **${plural(r.deletedCount, 'role link')}**.`);
  },

  async syncvouches(m, [chan]) {
    const id = chan?.match(/^<#(\d+)>$/)?.[1] ?? chan;
    const ch = id ? await bot.channels.fetch(id).catch(() => null) : null;
    if (!ch?.isTextBased()) return usage('Sync vouches', 'syncvouches #channel');
    await config.updateOne({ _id: 'vouchChannel' }, { $set: { id: ch.id } }, { upsert: true });
    vc = ch.id;
    const n = await syncVouches(ch);
    return ok('Vouches synced', `**${plural(n, 'message')}** synced from ${ch}.`, '-# New, edited and deleted messages in this channel now update the website live.');
  },

  async syncprofile() {
    const { added, removed } = await reconcile();
    return ok('Profiles synced', `**${plural(tracked.size, 'user')}** checked.`, `**${added}** added  |  **${removed}** removed through roles`);
  },

  async help() {
    return HELP;
  },
};

bot.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.inGuild() || !m.content.startsWith(PREFIX)) return;
  const [name, ...args] = m.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = run[name?.toLowerCase()];
  if (!cmd) return;
  const quiet = { repliedUser: false, users: [], roles: [] };
  // Sent as a normal message, not a reply: replying needs Read Message History, which the bot may not have.
  // If the V2 message is blocked, fall back to plain text so the bot never goes silent.
  const say = async (v: View) => {
    try {
      await m.channel.send({ components: [render(v)], flags: MessageFlags.IsComponentsV2, allowedMentions: quiet });
    } catch (e) {
      logErr(`reply ${name}`, e);
      const plain = `**${v.title}**\n${v.sections.join('\n\n')}`.slice(0, 2000);
      await m.channel.send({ content: plain, allowedMentions: quiet }).catch((e2) => logErr(`send ${name}`, e2));
    }
  };
  console.log(`[cmd] ${m.author.tag} (${m.author.id}) ran !${name} in ${m.guild.name}`);
  try {
    await m.channel.sendTyping().catch(() => {});
    // The bot owner is always allowed; everyone else needs Manage Server.
    if (m.author.id !== OWNER_ID) {
      const member = await m.guild.members.fetch({ user: m.author.id, cache: false });
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return void (await say(fail('No permission', 'You need **Manage Server** or higher to use this bot.')));
      }
    }
    if (!gid) {
      gid = m.guildId;
      await config.updateOne({ _id: 'guild' }, { $set: { id: gid } }, { upsert: true });
    } else if (gid !== m.guildId) {
      return void (await say(fail('Wrong server', 'This bot is bound to a different server.')));
    }
    await say(await cmd(m, args));
  } catch (e) {
    logErr(`cmd ${name}`, e);
    await say(fail('Something went wrong', `\`${(e as Error).message}\``));
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
