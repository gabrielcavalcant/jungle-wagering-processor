import { loadConfig } from '../../config';
import { createOrm } from './orm';

/** `bun run migration:up` / `bun run migration:down` */
async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  const orm = await createOrm(loadConfig().db);
  try {
    const migrator = orm.getMigrator();
    const applied = direction === 'down' ? await migrator.down() : await migrator.up();
    console.log(JSON.stringify({ msg: `migrations ${direction}`, applied: applied.map((m) => m.name) }));
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
