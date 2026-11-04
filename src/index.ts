import {
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits as I,
  Message,
  MessageFlags,
  Options,
  PermissionFlagsBits,
  Routes,
  TextDisplayBuilder,
  type APIGuildMember,
  type TextBasedChannel,
} from 'discord.js';
import { config, users, vouches } from './db.js';

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

// Guild is stored in Mongo (config.guild); it is bound by the first command run in a server.
let gid: string | undefined = (await config.findOne({ _id: 'guild' }))?.id;
let vc: string | undefined = (await config.findOne({ _id: 'vouchChannel' }))?.id;
const tracked = new Set<string>((await users.find({}, { projection: { _id: 1 } }).toArray()).map((u) => u._id));

async function profile(id: string) {
  const u = await bot.users.fetch(id, { force: true });
  const g = gid ? bot.guilds.cache.get(gid) : undefined;
  const m = await g?.members.fetch({ user: id, cache: false }).catch(() => null);
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

async function refresh(id: string) {
  const doc = await users.findOne({ _id: id });
  if (!doc) return false;
  const { _id, addedAt, addedBy, syncedAt, ...old } = doc;
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
      console.error(`profile ${id}:`, (e as Error).message);
    }
  }
  return n;
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

async function roleIds(role: string) {
  if (!gid) return [];
  const out: string[] = [];
  let after = '0';
  for (;;) {
    const p = (await bot.rest.get(Routes.guildMembers(gid), {
      query: new URLSearchParams({ limit: '1000', after }),
    })) as APIGuildMember[];
    for (const m of p) if (m.roles.includes(role) && !m.user.bot) out.push(m.user.id);
    if (p.length < 1000) return out;
    after = p.at(-1)!.user.id;
  }
}

// ---------- Command layer: one implementation, reachable via slash and prefix ----------

const PREFIX = process.env.PREFIX ?? '!';
const GREEN = 0x57f287;
const RED = 0xed4245;
const BLURPLE = 0x5865f2;

type View = { title: string; text: string; color?: number };
const ok = (title: string, text: string): View => ({ title, text, color: GREEN });
const fail = (title: string, text: string): View => ({ title, text, color: RED });
const info = (title: string, text: string): View => ({ title, text, color: BLURPLE });

// Components V2 container: a clean embed-style card with a coloured accent bar.
const card = (v: View) =>
  new ContainerBuilder()
    .setAccentColor(v.color ?? BLURPLE)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${v.title}\n${v.text}`));

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

  async resetusers() {
    const { deletedCount } = await users.deleteMany({});
    tracked.clear();
    return ok('Reset users', `${deletedCount} tracked users cleared.`);
  },
};

// Shared gatekeeping + execution. Returns the view to send back.
async function dispatch(name: string, c: Ctx): Promise<View> {
  if (!c.canManage) return fail('No permission', 'You need Manage Server or higher to use this bot.');
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
    console.error(e);
    return fail('Error', (e as Error).message);
  }
}

const allowed = (id: string, perms?: { has(p: bigint): boolean } | null) =>
  id === OWNER_ID || !!perms?.has(PermissionFlagsBits.ManageGuild);

// Slash
bot.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || !run[i.commandName]) return;
  const flags = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
  await i.deferReply({ flags });
  const v = await dispatch(i.commandName, {
    guildId: i.guildId,
    userId: i.user.id,
    canManage: allowed(i.user.id, i.memberPermissions),
    users: [i.options.getUser('user')?.id].filter((x): x is string => !!x),
    roles: [i.options.getRole('role')?.id].filter((x): x is string => !!x),
    channel: i.options.getChannel('channel')?.id,
  });
  await i.editReply({ components: [card(v)], flags: MessageFlags.IsComponentsV2 });
});

// Prefix
bot.on(Events.MessageCreate, async (m) => {
  if (m.author.bot) return;
  // Triggered by "<prefix>cmd" or "@bot cmd"
  const mention = new RegExp(`^<@!?${bot.user?.id}>\\s*`).exec(m.content);
  const body = mention ? m.content.slice(mention[0].length) : m.content.startsWith(PREFIX) ? m.content.slice(PREFIX.length) : null;
  if (body === null) return;
  const [cmd, ...args] = body.trim().split(/\s+/);
  const name = cmd?.toLowerCase();
  if (!name || !Object.hasOwn(run, name)) return;

  const ids = (re: RegExp) => args.map((a) => a.match(re)?.[1]).filter((x): x is string => !!x);
  const v = await dispatch(name, {
    guildId: m.guildId,
    userId: m.author.id,
    canManage: allowed(m.author.id, m.member?.permissions),
    users: [...ids(/^<@!?(\d+)>$/), ...ids(/^(\d{17,20})$/)],
    roles: ids(/^<@&(\d+)>$/),
    channel: ids(/^<#(\d+)>$/)[0],
  });
  await m
    .reply({ components: [card(v)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], repliedUser: false } })
    .catch((e) => console.error('reply:', e.message));
});


const timers = new Map<string, NodeJS.Timeout>();

const debounce = (id: string) => {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      refresh(id).catch((e) => console.error(`live profile ${id}:`, e.message));
    }, 2000),
  );
};

bot.on(Events.Raw, async ({ t, d }: { t: string; d: any }) => {
  try {
    if (t === 'GUILD_MEMBER_UPDATE') {
      if (d.guild_id === gid && tracked.has(d.user.id)) debounce(d.user.id);
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
    console.error(`live ${t}:`, (e as Error).message);
  }
});

bot.once(Events.ClientReady, (c) => {
  console.log(`Ready as ${c.user.tag}`);
  setInterval(() => scan().catch(console.error), 30 * 60_000);
});

await bot.login(process.env.DISCORD_TOKEN);
