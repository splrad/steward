import {DatabaseSync} from 'node:sqlite';
/** SQLite test storage exercises the same transaction/alarm adapter as the DO. */
export class SqliteDurableStorage {
 db:DatabaseSync;
 constructor(path=':memory:'){this.db=new DatabaseSync(path);this.db.exec('CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');}
 async get<T>(key:string):Promise<T|undefined>{const row=this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);return row?JSON.parse(row.value as string):undefined;}
 async put(key:string,value:unknown){this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
 async delete(key:string){return this.db.prepare('DELETE FROM kv WHERE key=?').run(key).changes>0;}
 async setAlarm(at:number){await this.put('__alarm',at);}
 async deleteAlarm(){this.db.prepare('DELETE FROM kv WHERE key=?').run('__alarm');}
 async transaction<T>(fn:(txn:this)=>Promise<T>):Promise<T>{this.db.exec('BEGIN IMMEDIATE');try{const result=await fn(this);this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
