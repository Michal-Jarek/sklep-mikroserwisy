// Prisma CLI configuration (generate, migrate). The connection URL is built only from DB_* variables.
import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Local runs (VS Code): read services/auth-service/.env when present. Real environment variables win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function databaseUrl(name: string | undefined): string | undefined {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = process.env;
  if (!DB_HOST || !DB_USER || !DB_PASSWORD || !name) {
    // "prisma generate" does not need a database.
    return undefined;
  }
  const user = encodeURIComponent(DB_USER);
  const password = encodeURIComponent(DB_PASSWORD);
  return `postgresql://${user}:${password}@${DB_HOST}:${DB_PORT ?? '5432'}/${encodeURIComponent(name)}`;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: databaseUrl(process.env.DB_NAME),
    // Only for "prisma migrate dev" (local): auth_shadow_db, owned by auth_service (no CREATEDB needed).
    shadowDatabaseUrl: databaseUrl(process.env.DB_SHADOW_NAME),
  },
});
