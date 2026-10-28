import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config';
import { Migration20261028000001_initial_schema } from './migrations/Migration20261028000001_initial_schema';

/** Explicit list: no filesystem globbing, works the same under Bun, Docker and tests. */
export const MIGRATIONS = [
  { name: 'Migration20261028000001_initial_schema', class: Migration20261028000001_initial_schema },
];

export async function createOrm(db: AppConfig['db']): Promise<MikroORM> {
  return MikroORM.init({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    dbName: db.dbName,
    pool: { min: 1, max: db.poolMax },
    // Repositories use explicit SQL (see ARCHITECTURE.md §Persistence); no entity metadata needed.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: false,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
