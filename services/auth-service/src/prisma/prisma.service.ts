import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/** Prisma client connected with the DB_* settings (no DATABASE_URL). Connects lazily on first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { host, port, name, user, password } = config.db;
    super({
      adapter: new PrismaPg({ host, port, database: name, user, password, connectionTimeoutMillis: 2000 }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
