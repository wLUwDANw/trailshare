/**
 * 好友（收件人）名单。
 *
 * 为什么单独开一个 IndexedDB：主库（src/store/db.ts）的表结构里没有 friends，
 * 而本轮改动不允许动 db.ts。与其为了一个表去改主库 schema 并触发版本升级，
 * 不如把好友名单放进独立的小库——它本来就是"本机通讯录"，和记忆/溯源边没有事务关联。
 *
 * 好友只存三样东西：公钥、名字、X25519 公钥（由公钥派生，用于加密）。
 * 没有任何"加好友协议"，公钥靠线下/其他渠道交换，见 README。
 */
import { openDB, type IDBPDatabase } from 'idb';
import { ed25519ToX25519Pub, generateIdentityFromSeed } from '../crypto/keys';

export interface Friend {
  /** ed25519:<hex> —— 与分享包里的写法一致 */
  pubkey: string;
  name: string;
  addedAt: string;
  x25519Pub: string;
}

const DB_NAME = 'trailshare-friends';
const DB_VERSION = 1;
const STORE = 'friends';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'pubkey' });
        }
      },
    });
  }
  return dbPromise;
}

function bareHex(pubkey: string): string {
  return pubkey.startsWith('ed25519:') ? pubkey.slice('ed25519:'.length) : pubkey;
}

function normalizeFriendPubkey(pubkey: string): string {
  const hex = bareHex(pubkey).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('公钥必须是 64 位十六进制');
  return `ed25519:${hex}`;
}

/** 新增 / 覆盖好友。X25519 公钥缺失或非法时由 Ed25519 公钥派生。 */
export async function addFriend(friend: Friend): Promise<void> {
  const pubkey = normalizeFriendPubkey(friend.pubkey);
  const provided = friend.x25519Pub?.trim().toLowerCase() ?? '';
  const x25519Pub = /^[0-9a-f]{64}$/.test(provided) ? provided : ed25519ToX25519Pub(pubkey);

  const db = await getDB();
  await db.put(STORE, {
    pubkey,
    name: friend.name.trim() || '朋友',
    addedAt: friend.addedAt || new Date().toISOString(),
    x25519Pub,
  });
}

export async function removeFriend(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, normalizeFriendPubkey(pubkey));
}

export async function listFriends(): Promise<Friend[]> {
  const db = await getDB();
  const rows = await db.getAll(STORE);
  return rows.sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));
}

export async function getFriend(pubkey: string): Promise<Friend | null> {
  const db = await getDB();
  return (await db.get(STORE, normalizeFriendPubkey(pubkey))) ?? null;
}

/** 仅供测试：清空好友表。 */
export async function clearFriends(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE);
}

/**
 * 开发占位：首次启动塞 3 个写死的测试好友。
 * 幂等——表里已经有数据就什么都不做。
 *
 * 名字带 [测试] 前缀，提醒使用者这不是真实联系人；
 * 他们的私钥在仓库里是公开的（固定种子），任何人都不该拿这些身份做真实分享。
 */
const DEMO_FRIENDS: Array<{ seed: string; name: string }> = [
  { seed: '11'.repeat(32), name: '好友A' },
  { seed: '22'.repeat(32), name: '好友B' },
  { seed: '33'.repeat(32), name: '好友C' },
];

export async function seedDemoFriends(): Promise<void> {
  const db = await getDB();
  if ((await db.count(STORE)) > 0) return;

  const addedAt = new Date().toISOString();
  for (const demo of DEMO_FRIENDS) {
    const identity = generateIdentityFromSeed(demo.seed);
    await db.put(STORE, {
      pubkey: identity.pubkey,
      name: `[测试]${demo.name}`,
      addedAt,
      x25519Pub: identity.x25519Pub,
    });
  }
}

/** 仅供测试：拿到内置测试好友的身份，便于脚本里扮演 A/B/C。 */
export function demoFriendIdentity(name: '好友A' | '好友B' | '好友C') {
  const demo = DEMO_FRIENDS.find((d) => d.name === name);
  if (!demo) throw new Error(`没有这个测试好友：${name}`);
  return generateIdentityFromSeed(demo.seed);
}
