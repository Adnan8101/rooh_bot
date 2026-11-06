import {
  type APIGuildMember,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits as I,
  GatewayOpcodes,
  type Guild,
  type GuildMember,
  Message,
  MessageFlags,
  Options,
  PermissionFlagsBits,
  Routes,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type TextBasedChannel,
} from 'discord.js';
import { config, roles, users, vouches } from './db.js';

const PREFIX = '!';
// Website tiers, highest first. Must match TIERS in website/app/team/data.ts.
const TIERS = ['Owner', 'Imposter', 'Malkin', 'Developer', 'Co Owner', 'Manager', 'Head Mod', 'Staff Team'];

const NO_CACHE = [
  'MessageManager', 'PresenceManager', 'ReactionManager',
  'ReactionUserManager', 'VoiceStateManager', 'GuildEmojiManager', 'GuildStickerManager',
  'GuildScheduledEventManager', 'StageInstanceManager', 'ThreadManager', 'ThreadMemberManager',
  'GuildInviteManager', 'GuildBanManager', 'AutoModerationRuleManager', 'BaseGuildEmojiManager',
  'DMMessageManager', 'GuildForumThreadManager', 'GuildMessageManager', 'GuildTextThreadManager',
  'ApplicationCommandManager', 'EntitlementManager', 'SubscriptionManager',
];

const bot = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildMessages, I.MessageContent],
  makeCache: Options.cacheWithLimits({
    ...Object.fromEntries(NO_CACHE.map((k) => [k, 0])),
    // Keep a small bounded cache of recent users/members so m.member is available on MessageCreate without an extra REST fetch.
    UserManager: 250,
    GuildMemberManager: 250,
  }),
});

const OWNER_ID = '929297205796417597';

const logErr = (scope: string, e: unknown) => console.error(`[${scope}]`, e instanceof Error ? e.message : e);

// Load initial state in parallel instead of 4 sequential database round-trips.
const [cfgDocs, userDocs, roleDocs] = await Promise.all([
  config.find().toArray(),
  users.find({}, { projection: { _id: 1 } }).toArray(),
  roles.find().toArray(),
]);

// Guild is stored in Mongo (config.guild); it is bound by the first command run in a server.
let gid: string | undefined = cfgDocs.find((c) => c._id === 'guild')?.id;
let vc: string | undefined = cfgDocs.find((c) => c._id === 'vouchChannel')?.id;
const tracked = new Set<string>(userDocs.map((u) => String(u._id)));
// Discord role id -> website tier
const roleMap = new Map<string, string>(roleDocs.map((r) => [String(r._id), r.tier]));

const guild = () => (gid ? bot.guilds.cache.get(gid) : undefined);

/** Runs fn over items with at most n requests in flight. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (const x of it) await fn(x).catch((e) => logErr('pool', e));
    }),
  );
}

/** Everything the website needs that comes with a guild member, with no extra request. */
const fromMember = (m: GuildMember) => ({
  username: m.user.username,
  globalName: m.user.globalName,
  displayName: m.displayName,
  bot: m.user.bot,
  avatar: m.displayAvatarURL({ size: 512 }),
  ...(m.banner ? { banner: m.bannerURL({ size: 1024 }) } : {}),
  createdAt: m.user.createdAt,
  joinedAt: m.joinedAt ?? null,
  roles: m.roles.cache.filter((r) => r.id !== gid).map((r) => ({ id: r.id, name: r.name })),
});

/** Full profile: user (for banner/accent) and member fetched in parallel. */
async function profile(id: string) {
  const [u, m] = await Promise.all([
    bot.users.fetch(id, { force: true }),
    guild()?.members.fetch({ user: id, cache: false }).catch(() => null) ?? null,
  ]);
  return {
    username: u.username,
    globalName: u.globalName,
    displayName: m?.displayName ?? u.displayName,
    bot: u.bot,
    avatar: (m ?? u).displayAvatarURL({ size: 512 }),
    banner: m?.bannerURL({ size: 1024 }) ?? u.bannerURL({ size: 1024 }) ?? null,
    accentColor: u.hexAccentColor ?? null,
    createdAt: u.createdAt,
    joinedAt: m?.joinedAt ?? null,
    roles: m ? m.roles.cache.filter((r) => r.id !== gid).map((r) => ({ id: r.id, name: r.name })) : [],
  };
}

const save = (id: string) =>
  profile(id)
    .then((p) => users.updateOne({ _id: id }, { $set: { ...p, syncedAt: new Date() } }))
    .catch((e) => logErr(`profile ${id}`, e));

/** Banner and accent colour are the only things a member listing leaves out. */
const saveBanner = async (id: string) => {
  const u = await bot.users.fetch(id, { force: true });
  await users.updateOne(
    { _id: id },
    { $set: { banner: u.bannerURL({ size: 1024 }) ?? null, accentColor: u.hexAccentColor ?? null } },
  );
};

/** Deterministic field comparison independent of MongoDB key ordering. */
function sameProfile(old: any, next: Awaited<ReturnType<typeof profile>>) {
  if (!old) return false;
  if (
    old.username !== next.username ||
    old.globalName !== next.globalName ||
    old.displayName !== next.displayName ||
    old.bot !== next.bot ||
    old.avatar !== next.avatar ||
    (old.banner ?? null) !== next.banner ||
    (old.accentColor ?? null) !== next.accentColor ||
    +(old.joinedAt ?? 0) !== +(next.joinedAt ?? 0)
  ) {
    return false;
  }
  const oldRoles: { id: string; name: string }[] = old.roles ?? [];
  if (oldRoles.length !== next.roles.length) return false;
  return oldRoles.every((r, i) => r.id === next.roles[i]?.id && r.name === next.roles[i]?.name);
}

async function refresh(id: string, existingDoc?: any) {
  const doc = existingDoc ?? (await users.findOne({ _id: id }));
  if (!doc) return false;
  const next = await profile(id);
  if (sameProfile(doc, next)) return false;
  await users.updateOne({ _id: id }, { $set: { ...next, syncedAt: new Date() } });
  return true;
}

/** Re-read every tracked profile, 5 at a time. Runs on a timer and in the background, never while a command waits. */
async function scan() {
  const ids = [...tracked];
  if (!ids.length) return 0;
  const docs = await users.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  let n = 0;
  await pool(ids, 5, async (id) => {
    const doc = byId.get(id);
    if (doc && (await refresh(id, doc))) n++;
  });
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
    tracked.add(id);
    const p = await profile(id).catch((e) => {
      logErr(`profile ${id}`, e);
      return null;
    });
    const now = new Date();
    await users.updateOne(
      { _id: id },
      { $set: { ...(p ? { ...p, syncedAt: now } : {}) }, $setOnInsert: { addedAt: now, addedBy: 'role' } },
      { upsert: true },
    );
  } else if (!linked && tracked.has(id)) {
    const { deletedCount } = await users.deleteOne({ _id: id, ...roleOnly });
    if (deletedCount) tracked.delete(id);
    else await refresh(id);
  } else if (linked) {
    await refresh(id);
  }
}

/*
 * Short-lived (60s) cache of non-bot guild members who hold at least one role.
 * Makes consecutive !addrole / !syncprofile commands instantaneous (<5ms) without re-scanning the server,
 * and frees all memory after 60s of inactivity.
 */
let roleHoldersCache: Map<string, APIGuildMember> | null = null;
let roleHoldersTimer: NodeJS.Timeout | null = null;

function setRoleHoldersCache(map: Map<string, APIGuildMember>) {
  roleHoldersCache = map;
  if (roleHoldersTimer) clearTimeout(roleHoldersTimer);
  roleHoldersTimer = setTimeout(() => {
    roleHoldersCache = null;
    roleHoldersTimer = null;
  }, 60_000).unref();
}

/** Stream non-bot members with roles via Gateway Opcode 8 (~1s), falling back to REST if Opcode 8 is rate-limited. */
async function fetchRoleHolders(g: Guild): Promise<Map<string, APIGuildMember>> {
  if (roleHoldersCache) return roleHoldersCache;

  const gatewayResult = await new Promise<Map<string, APIGuildMember> | null>((resolve) => {
    const out = new Map<string, APIGuildMember>();
    const nonce = Date.now().toString(16);
    let received = 0;

    const cleanup = () => {
      clearTimeout(timer);
      bot.off(Events.Raw, onRaw);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 10_000).unref();

    const onRaw = ({ t, d }: { t: string; d: any }) => {
      if (t === 'RATE_LIMITED' && d?.meta?.nonce === nonce) {
        cleanup();
        resolve(null);
        return;
      }
      if (t !== 'GUILD_MEMBERS_CHUNK' || d?.nonce !== nonce) return;
      timer.refresh();
      received++;
      for (const m of (d.members ?? []) as APIGuildMember[]) {
        if (!m.user?.bot && m.roles?.length > 0) out.set(m.user.id, m);
      }
      if (received >= d.chunk_count || (d.members?.length ?? 0) < 1000) {
        cleanup();
        resolve(out);
      }
    };

    bot.on(Events.Raw, onRaw);
    g.shard.send({
      op: GatewayOpcodes.RequestGuildMembers,
      d: { guild_id: g.id, query: '', limit: 0, nonce },
    });
  });

  if (gatewayResult) {
    setRoleHoldersCache(gatewayResult);
    return gatewayResult;
  }

  // Fallback: read over REST 1000 at a time, keeping only non-bot members who hold roles.
  const out = new Map<string, APIGuildMember>();
  let after = '0';
  for (;;) {
    const page = (await bot.rest.get(Routes.guildMembers(g.id), {
      query: new URLSearchParams({ limit: '1000', after }),
    })) as APIGuildMember[];
    for (const m of page) {
      if (!m.user?.bot && m.roles?.length > 0) out.set(m.user.id, m);
    }
    if (page.length < 1000) break;
    after = page.reduce((a, b) => (BigInt(a) > BigInt(b.user.id) ? a : b.user.id), '0');
  }
  setRoleHoldersCache(out);
  return out;
}

// Runs one reconcile at a time; overlapping calls queue up instead of colliding.
let queue: Promise<{ added: number; removed: number }> = Promise.resolve({ added: 0, removed: 0 });
function reconcile(bypassCache = false) {
  if (bypassCache) roleHoldersCache = null;
  const next = queue.then(reconcileNow);
  queue = next.catch(() => ({ added: 0, removed: 0 }));
  return next;
}

/**
 * Full pass over the server: make the role-based part of the team match Discord exactly.
 * Skips scanning the server entirely when no roles are linked, and only constructs GuildMember
 * instances for the handful of members who actually hold a linked role.
 */
async function reconcileNow() {
  const g = guild();
  if (!g) return { added: 0, removed: 0 };

  if (!roleMap.size) {
    const stale = await users.find(roleOnly, { projection: { _id: 1 } }).toArray();
    if (stale.length) await users.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
    for (const u of stale) tracked.delete(String(u._id));
    return { added: 0, removed: stale.length };
  }

  const holders = await fetchRoleHolders(g);
  const want: GuildMember[] = [];
  for (const raw of holders.values()) {
    if (raw.roles.some((r) => roleMap.has(r))) {
      want.push((g.members as any)._add(raw, false) as GuildMember);
    }
  }

  const fresh = want.filter((m) => !tracked.has(m.id)).map((m) => m.id);
  const now = new Date();
  if (want.length) {
    await users.bulkWrite(
      want.map((m) => ({
        updateOne: {
          filter: { _id: m.id },
          update: { $set: { ...fromMember(m), syncedAt: now }, $setOnInsert: { addedAt: now, addedBy: 'role' } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  for (const id of fresh) tracked.add(id);
  if (fresh.length) void pool(fresh, 5, saveBanner);

  const keep = want.map((m) => m.id);
  const stale = await users.find({ ...roleOnly, _id: { $nin: keep } }, { projection: { _id: 1 } }).toArray();
  if (stale.length) await users.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
  for (const u of stale) tracked.delete(String(u._id));
  return { added: fresh.length, removed: stale.length };
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
  const writes: Promise<unknown>[] = [];
  for (;;) {
    const b = await ch.messages.fetch({ limit: 100, before, cache: false });
    if (!b.size) break;
    writes.push(
      vouches.bulkWrite(
        b.map((m) => ({ updateOne: { filter: { _id: m.id }, update: { $set: vouch(m) }, upsert: true } })),
        { ordered: false },
      ),
    );
    n += b.size;
    before = b.last()!.id;
  }
  await Promise.all(writes);
  return n;
}

const TIER_ALIASES: Record<string, string> = {
  dev: 'Developer',
  developer: 'Developer',
  devs: 'Developer',
  maalkin: 'Malkin',
  coowner: 'Co Owner',
  headmod: 'Head Mod',
  mod: 'Head Mod',
  staff: 'Staff Team',
  staffteam: 'Staff Team',
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const tier = (s: string) => {
  const k = key(s);
  return TIERS.find((t) => key(t) === k) ?? TIER_ALIASES[k];
};
const userId = (a = '') => a.match(/^<@!?(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
const roleId = (a = '') => a.match(/^<@&(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- Reply UI ----------
// Every reply is one Components V2 container: title, sections split by dividers, small footer.
// No accent colour by default; a green bar for success, a red bar for errors, a violet bar for role cards.

const GREEN = 0x57f287;
const RED = 0xed4245;
const VIOLET = 0x8b3dff;

type View = { title: string; sections: string[]; tone?: 'ok' | 'error' | 'brand'; footer?: string };

const info = (title: string, ...sections: string[]): View => ({ title, sections });
const ok = (title: string, ...sections: string[]): View => ({ title, sections, tone: 'ok' });
const fail = (title: string, ...sections: string[]): View => ({ title, sections, tone: 'error' });
const brand = (title: string, ...sections: string[]): View => ({ title, sections, tone: 'brand' });
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
  if (v.tone) c.setAccentColor(v.tone === 'ok' ? GREEN : v.tone === 'brand' ? VIOLET : RED);
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
    [
      '**Website users**',
      cmdLine('adduser @user <tier>', 'Put a member on the website in a tier'),
      cmdLine('removeuser @user', 'Take a member off the website'),
      cmdLine('listusers', 'Everyone on the website, by tier'),
    ].join('\n'),
    [
      '**Roles & Cards**',
      cmdLine('addrole @role <tier>', 'Everyone with this role goes in that tier'),
      cmdLine('removerole @role', 'Unlink a role'),
      cmdLine('listroles', 'Linked roles and their tiers'),
      cmdLine('developer', 'Display the Developer role card'),
      cmdLine('rolecard [tier]', 'Display the role card for a tier (defaults to Developer)'),
    ].join('\n'),
    [
      '**Sync**',
      cmdLine('syncvouches #channel', 'Sync every message in the vouch channel'),
      cmdLine('syncprofile', 'Refresh profiles and role members'),
    ].join('\n'),
    ['**Data**', cmdLine('resetdata confirm', 'Delete all website users and role links. Vouches are kept')].join('\n'),
    `${tierHelp}\n-# Someone who qualifies for several tiers is shown once, in the highest.`,
  ],
};

/** Builds a rich Components V2 role card for a tier (such as Developer). */
async function buildRoleCard(targetTier = 'Developer'): Promise<View> {
  const rank = TIERS.indexOf(targetTier);
  const list = await users
    .find({ bot: { $ne: true } }, { projection: { username: 1, displayName: 1, globalName: 1, manualTier: 1, roles: 1 } })
    .toArray();
  const members = list.filter((u) => tierOf(u) === targetTier);
  const linkedRoles = [...roleMap.entries()].filter(([, t]) => t === targetTier).map(([id]) => `<@&${id}>`);

  const desc =
    targetTier === 'Developer'
      ? 'Builds and maintains the ROOH Discord bot, website and community systems.'
      : `Tier **#${rank + 1}** on the ROOH team hierarchy.`;

  const memberLines = members.length
    ? members
        .map((u) => {
          const handle = u.username ? ` (\`@${u.username}\`)` : '';
          const via = u.manualTier === targetTier ? '' : '  -# via role';
          return `• <@${u._id}>${handle}${via}`;
        })
        .join('\n')
    : `No one is listed in **${targetTier}** yet.\n-# Add someone with \`${PREFIX}adduser @user ${targetTier}\` or link a role with \`${PREFIX}addrole @role ${targetTier}\`.`;

  const roleLines = linkedRoles.length
    ? linkedRoles.join('  ')
    : `No Discord role linked yet.\n-# Link one with \`${PREFIX}addrole @role ${targetTier}\`.`;

  return {
    ...brand(
      `${targetTier} · Role Card`,
      `${desc}\n-# Rank ${String(rank + 1).padStart(2, '0')} of ${String(TIERS.length).padStart(2, '0')} on the website`,
      `**Members (${members.length})**\n${memberLines}`,
      `**Linked Discord Roles (${linkedRoles.length})**\n${roleLines}`,
    ),
    footer: `ROOH  |  ${targetTier} role card  |  ${plural(members.length, 'member')}`,
  };
}

// ---------- Commands ----------

const run: Record<string, (m: Message, args: string[]) => Promise<View>> = {
  async adduser(m, [who, ...rest]) {
    const id = userId(who);
    const t = tier(rest.join(' '));
    if (!id || !t) return usage('Add user', 'adduser @user <tier>', tierHelp);
    const wasTracked = tracked.has(id);
    tracked.add(id);
    const p = await profile(id).catch((e) => {
      logErr(`profile ${id}`, e);
      return null;
    });
    const now = new Date();
    const r = await users.updateOne(
      { _id: id },
      {
        $set: { ...(p ? { ...p, syncedAt: now } : {}), manualTier: t, addedBy: m.author.id },
        $setOnInsert: { addedAt: now },
      },
      { upsert: true },
    );
    const added = Boolean(r.upsertedCount || !wasTracked);
    const shown = tierOf({ manualTier: t, roles: p?.roles });
    return ok(
      added ? 'User added' : 'Tier updated',
      `<@${id}> ${added ? 'is now on the website as' : 'is now'} **${t}**.`,
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
    const role = id ? (m.guild!.roles.cache.get(id) ?? (await m.guild!.roles.fetch(id).catch(() => null))) : null;
    if (!role || !t) return usage('Add role', 'addrole @role <tier>', tierHelp);
    await roles.updateOne({ _id: role.id }, { $set: { name: role.name, tier: t, addedBy: m.author.id, addedAt: new Date() } }, { upsert: true });
    roleMap.set(role.id, t);
    const { added } = await reconcile();
    return ok(
      'Role linked',
      `Everyone with ${role} now shows as **${t}** on the website.`,
      `**${plural(added, 'new member')}** added\n-# Members gaining or losing this role update automatically.`,
    );
  },

  async removerole(m, [r]) {
    const id = roleId(r);
    if (!id) return usage('Remove role', 'removerole @role');
    const { deletedCount } = await roles.deleteOne({ _id: id });
    roleMap.delete(id);
    if (!deletedCount) return fail('Remove role', `<@&${id}> is not linked to a tier.`);
    // Drop role-only users who no longer hold any linked role directly in Mongo (no full-server scan needed).
    const remaining = [...roleMap.keys()];
    const filter = remaining.length ? { ...roleOnly, 'roles.id': { $nin: remaining } } : roleOnly;
    const stale = await users.find(filter, { projection: { _id: 1 } }).toArray();
    if (stale.length) {
      await users.deleteMany({ _id: { $in: stale.map((u) => u._id) } });
      for (const u of stale) tracked.delete(String(u._id));
    }
    return ok(
      'Role unlinked',
      `<@&${id}> no longer places anyone on the website.`,
      `**${plural(stale.length, 'member')}** removed\n-# Only people who were listed through this role alone.`,
    );
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
    return {
      ...info('Website users', ...(sections.length ? sections : ['Nobody yet. Add someone with `!adduser` or link a role with `!addrole`.'])),
      footer: `${plural(shown, 'person')} on the website  |  (role) = listed through a linked role`,
    };
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

  async developer() {
    return buildRoleCard('Developer');
  },

  async dev() {
    return buildRoleCard('Developer');
  },

  async rolecard(_m, args) {
    const query = args.join(' ').trim();
    const t = query ? tier(query) : 'Developer';
    if (!t) return usage('Role card', 'rolecard [tier]', tierHelp);
    return buildRoleCard(t);
  },

  async card(m, args) {
    return run.rolecard(m, args);
  },

  async resetdata(_m, [confirm]) {
    if (confirm !== 'confirm')
      return fail('Reset data', 'This deletes **every website user and role link**. Vouches are kept.', `Run \`${PREFIX}resetdata confirm\` to go ahead.`);
    const [u, r] = await Promise.all([users.deleteMany({}), roles.deleteMany({})]);
    tracked.clear();
    roleMap.clear();
    return ok('Data reset', `Deleted **${plural(u.deletedCount, 'user')}** and **${plural(r.deletedCount, 'role link')}**.`);
  },

  async syncvouches(_m, [chan]) {
    const id = chan?.match(/^<#(\d+)>$/)?.[1] ?? chan;
    const ch = id ? (bot.channels.cache.get(id) ?? (await bot.channels.fetch(id).catch(() => null))) : null;
    if (!ch?.isTextBased()) return usage('Sync vouches', 'syncvouches #channel');
    await config.updateOne({ _id: 'vouchChannel' }, { $set: { id: ch.id } }, { upsert: true });
    vc = ch.id;
    const n = await syncVouches(ch);
    return ok('Vouches synced', `**${plural(n, 'message')}** synced from ${ch}.`, '-# New, edited and deleted messages in this channel now update the website live.');
  },

  async syncprofile() {
    const { added, removed } = await reconcile(true);
    void scan().catch((e) => logErr('scan', e)); // full profile refresh continues in the background
    return ok('Profiles synced', `**${added}** added  |  **${removed}** removed through roles`, `-# Refreshing ${plural(tracked.size, 'profile')} in the background.`);
  },

  async help() {
    return HELP;
  },
};

bot.on(Events.MessageCreate, async (m) => {
  // Live vouch capture directly from MessageCreate (zero extra REST calls).
  if (m.channelId === vc && !m.author.bot) {
    vouches.updateOne({ _id: m.id }, { $set: vouch(m) }, { upsert: true }).catch((e) => logErr('vouch create', e));
  }

  if (m.author.bot || !m.inGuild() || !m.content.startsWith(PREFIX)) return;
  const [name, ...args] = m.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmdName = name?.toLowerCase();
  const cmd = cmdName ? run[cmdName] : undefined;
  if (!cmd) return;

  const quiet = { repliedUser: false, users: [], roles: [] };
  let pendingPromise: Promise<Message | null> | null = null;

  // Sent as a normal message, not a reply: replying needs Read Message History, which the bot may not have.
  // If the V2 message is blocked, fall back to plain text so the bot never goes silent.
  const say = async (v: View) => {
    try {
      const pendingMsg = pendingPromise ? await pendingPromise : null;
      if (pendingMsg) {
        await pendingMsg.edit({ components: [render(v)], flags: MessageFlags.IsComponentsV2, allowedMentions: quiet });
        return;
      }
      await m.channel.send({ components: [render(v)], flags: MessageFlags.IsComponentsV2, allowedMentions: quiet });
    } catch (e) {
      logErr(`reply ${cmdName}`, e);
      const plain = `**${v.title}**\n${v.sections.join('\n\n')}`.slice(0, 2000);
      await m.channel.send({ content: plain, allowedMentions: quiet }).catch((e2) => logErr(`send ${cmdName}`, e2));
    }
  };

  console.log(`[cmd] ${m.author.tag} (${m.author.id}) ran !${cmdName} in ${m.guild.name}`);
  let progressTimer: NodeJS.Timeout | undefined;
  try {
    // The bot owner and server owner are always allowed; everyone else needs Manage Server.
    if (m.author.id !== OWNER_ID && m.author.id !== m.guild.ownerId) {
      const member = m.member ?? (await m.guild.members.fetch({ user: m.author.id, cache: true }));
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

    // If a command takes more than 400ms (e.g. syncing vouches or cold server scan), show an immediate status card and edit it in place when done.
    progressTimer = setTimeout(() => {
      pendingPromise = m.channel
        .send({
          components: [render(info('Working on it...', `Running \`${PREFIX}${cmdName}\`...`))],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: quiet,
        })
        .catch(() => null);
    }, 400);

    const view = await cmd(m, args);
    clearTimeout(progressTimer);
    await say(view);
  } catch (e) {
    clearTimeout(progressTimer);
    logErr(`cmd ${cmdName}`, e);
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
      if (d.guild_id !== gid || !d.user?.id) return;
      const id: string = d.user.id;
      const memberRoles: string[] = d.roles ?? [];
      if (roleHoldersCache) {
        if (!d.user.bot && memberRoles.length > 0) roleHoldersCache.set(id, d as APIGuildMember);
        else roleHoldersCache.delete(id);
      }
      // Ignore members who are neither tracked nor holding a linked role.
      const linked = !d.user.bot && memberRoles.some((r) => roleMap.has(r));
      if (!linked && !tracked.has(id)) return;
      debounce(id, () => checkMember(id, memberRoles, d.user.bot));
      return;
    }
    if (t === 'GUILD_MEMBER_REMOVE') {
      if (d.guild_id !== gid || !d.user?.id) return;
      const id: string = d.user.id;
      roleHoldersCache?.delete(id);
      if (!tracked.has(id)) return;
      debounce(id, () => checkMember(id, null));
      return;
    }
    if (d?.channel_id !== vc) return;
    if (t === 'MESSAGE_UPDATE') {
      // Ignore embed unfurl events that do not modify content or attachments.
      if (d.content === undefined && d.attachments === undefined) return;
      const ch = (bot.channels.cache.get(d.channel_id) ?? (await bot.channels.fetch(d.channel_id))) as TextBasedChannel;
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
  reconcile().catch((e) => logErr('reconcile', e));
  // Every 30 min: match role members, then refresh avatars/banners for everyone (5 at a time).
  setInterval(() => reconcile(true).then(scan).catch((e) => logErr('reconcile', e)), 30 * 60_000);
});

await bot.login(process.env.DISCORD_TOKEN);
