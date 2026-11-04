import { MongoClient } from 'mongodb';

const m = new MongoClient(process.env.MONGODB_URI!, { maxPoolSize: 2, serverSelectionTimeoutMS: 15000 });
console.log(`${new Date().toISOString()} [db] connecting`);
try {
  await m.connect();
  console.log(`${new Date().toISOString()} [db] connected`);
} catch (e) {
  console.error(`${new Date().toISOString()} [db] connect FAILED (check Atlas IP allow list / URI):`, (e as Error).message);
  throw e;
}

const db = m.db('rooh');

export const vouches = db.collection<any>('vouches');
export const users = db.collection<any>('users');
export const config = db.collection<any>('config');

await Promise.all([vouches.createIndex({ createdAt: -1 }), vouches.createIndex({ 'author.id': 1 })]);
