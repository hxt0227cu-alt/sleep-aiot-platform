// Prisma ORM v7 的 CLI 配置（migrate / generate / validate 统一入口）。
// v7 不再默认自动加载 .env，显式 dotenv/config；DATABASE_URL 由这里供给 CLI。
// 运行时连接由 PrismaService 通过 @prisma/adapter-pg（PrismaPg）管理，与此处互不干扰。
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// v7 不再默认自动加载 .env，显式 dotenv/config。
// generate/validate 不需要真实连接串：缺失时用本地占位 URL 保证本地 DX；
// migrate（deploy/status）在 CI/生产环境由真实 DATABASE_URL 供给，缺失会在此直接报错。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/sleep_monitor',
  },
});
