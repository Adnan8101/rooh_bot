import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits as I,
  Message,
  MessageFlags,
  Options,
  Routes,
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

const emb = (t: string, d: string) => new EmbedBuilder().setTitle(t).setDescription(d);
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

async function targets(i: ChatInputCommandInteraction) {
  const ids = new Set<string>();
  const u = i.options.getUser('user');
  const r = i.options.getRole('role');
  if (u) ids.add(u.id);
  if (r) (await roleIds(r.id)).forEach((id) => ids.add(id));
  return [...ids];
}

const run: Record<string, (i: ChatInputCommandInteraction) => Promise<unknown>> = {
  async 'sync-vouches'(i) {
    const ch = await bot.channels.fetch(i.options.getChannel('channel', true).id);
    if (!ch?.isTextBased()) return i.editReply({ embeds: [emb('Sync vouches', 'Invalid channel.')] });
    await config.updateOne({ _id: 'vouchChannel' }, { $set: { id: ch.id } }, { upsert: true });
    vc = ch.id;
    const n = await syncVouches(ch);
    return i.editReply({ embeds: [emb('Sync vouches', `${n} messages synced from ${ch}.`)] });
  },

  async 'sync-profile'(i) {
    const n = await scan();
    return i.editReply({ embeds: [emb('Sync profile', `${tracked.size} scanned, ${n} updated.`)] });
  },

  async 'add-user'(i) {
    const ids = await targets(i);
    if (!ids.length) return i.editReply({ embeds: [emb('Add user', 'Provide a user or a role.')] });
    let n = 0;
    for (const id of ids) {
      const r = await users.updateOne(
        { _id: id },
        { $setOnInsert: { addedAt: new Date(), addedBy: i.user.id } },
        { upsert: true },
      );
      n += r.upsertedCount;
      tracked.add(id);
      await profile(id)
        .then((p) => users.updateOne({ _id: id }, { $set: { ...p, syncedAt: new Date() } }))
        .catch(() => {});
    }
    return i.editReply({ embeds: [emb('Add user', `${n} added, ${ids.length - n} already tracked.`)] });
  },

  async 'remove-user'(i) {
    const ids = await targets(i);
    if (!ids.length) return i.editReply({ embeds: [emb('Remove user', 'Provide a user or a role.')] });
    const { deletedCount } = await users.deleteMany({ _id: { $in: ids } });
    ids.forEach((id) => tracked.delete(id));
    return i.editReply({ embeds: [emb('Remove user', `${deletedCount} removed.`)] });
  },
};

bot.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || !run[i.commandName]) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!i.guildId) return void (await i.editReply({ embeds: [emb('Error', 'Use this in a server.')] }));
    if (!gid) {
      gid = i.guildId;
      await config.updateOne({ _id: 'guild' }, { $set: { id: gid } }, { upsert: true });
    } else if (gid !== i.guildId) {
      return void (await i.editReply({ embeds: [emb('Error', 'This bot is bound to a different server.')] }));
    }
    await run[i.commandName](i);
  } catch (e) {
    console.error(e);
    await i.editReply({ embeds: [emb('Error', (e as Error).message)] });
  }
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
