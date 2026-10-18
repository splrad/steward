import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.db, this.sql, values); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.values), meta: {} }; }
  async run() { return { success: true, results: [], meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } }; }
}
export class ReleaseTestDb {
  readonly database: DatabaseSync;
  constructor(path = ':memory:') {
    this.database = new DatabaseSync(path);
    if (!this.database.prepare("SELECT name FROM sqlite_master WHERE name='release_receipts'").get()) this.database.exec(readFileSync(new URL('../migrations/0010_release_receipts.sql', import.meta.url), 'utf8'));
    if (!this.database.prepare("SELECT name FROM sqlite_master WHERE name='release_generation'").get()) this.database.exec(readFileSync(new URL('../migrations/0011_release_generation.sql', import.meta.url), 'utf8'));
    if (!this.database.prepare("SELECT name FROM sqlite_master WHERE name='release_build_requests'").get()) this.database.exec(readFileSync(new URL('../migrations/0012_release_build_requests.sql', import.meta.url), 'utf8'));
    if (!this.database.prepare("SELECT name FROM sqlite_master WHERE name='release_build_restart_history'").get()) this.database.exec(readFileSync(new URL('../migrations/0013_release_build_restart.sql', import.meta.url), 'utf8'));
  }
  prepare(sql: string) { return new Statement(this.database, sql); }
  async batch(statements: Statement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const s of statements) results.push(await s.run()); this.database.exec('COMMIT'); return results; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  binding(): D1Database { return this as unknown as D1Database; }
}
