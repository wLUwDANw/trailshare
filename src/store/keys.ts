/** 本机密钥对存储（单用户，只有一条 id='me'）。 */
import { getDB } from './db';
import { generateKeyPair } from '../crypto/keys';
import type { KeyPairRecord } from '../types';

let cached: KeyPairRecord | null = null;

export async function loadKeyPair(): Promise<KeyPairRecord | null> {
  if (cached) return cached;
  const db = await getDB();
  const record = await db.get('keys', 'me');
  cached = record ?? null;
  return cached;
}

/** 首次启动时生成身份；已有则直接返回。 */
export async function ensureKeyPair(now: Date): Promise<KeyPairRecord> {
  const existing = await loadKeyPair();
  if (existing) return existing;
  const { privHex, pubHex } = generateKeyPair();
  const record: KeyPairRecord = { id: 'me', privHex, pubHex, createdAt: now.toISOString() };
  const db = await getDB();
  await db.put('keys', record);
  cached = record;
  return record;
}

export async function resetKeyPair(now: Date): Promise<KeyPairRecord> {
  const { privHex, pubHex } = generateKeyPair();
  const record: KeyPairRecord = { id: 'me', privHex, pubHex, createdAt: now.toISOString() };
  const db = await getDB();
  await db.put('keys', record);
  cached = record;
  return record;
}

export function __clearKeyCache(): void {
  cached = null;
}
