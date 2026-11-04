import { MongoClient } from 'mongodb';

const m = new MongoClient(process.env.MONGODB_URI!, { maxPoolSize: 2 });
await m.connect();

const db = m.db('rooh');

export const vouches = db.collection<any>('vouches');
export const users = db.collection<any>('users');
export const config = db.collection<any>('config');

await Promise.all([vouches.createIndex({ createdAt: -1 }), vouches.createIndex({ 'author.id': 1 })]);
