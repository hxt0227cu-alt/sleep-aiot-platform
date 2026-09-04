import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { DistributedLock } from './contracts';

@Injectable()
export class RedisService implements OnModuleDestroy, DistributedLock {
  private client: Redis;

  constructor(private configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (redisUrl) {
      this.client = new Redis(redisUrl);
      return;
    }

    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST') || 'localhost',
      port: Number(this.configService.get<string>('REDIS_PORT') || 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async set(key: string, value: string | number, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async del(...keys: string[]): Promise<void> {
    await this.client.del(...keys);
  }

  async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async incr(key: string): Promise<number> {
    return await this.client.incr(key);
  }

  async incrby(key: string, increment: number): Promise<number> {
    return await this.client.incrby(key, increment);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return await this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  /**
   * 返回一个独立连接（用于 Redis Pub/Sub 的 subscriber）。
   * ioredis 的连接一旦进入订阅模式就不能再执行普通命令，
   * 因此订阅方必须使用专用连接，不能与主连接混用。
   */
  duplicate(): Redis {
    return this.client.duplicate();
  }

  // ===== DistributedLock 实现（ADR-015） =====

  /**
   * 认领锁（DistributedLock.acquire）：在 ttlMs 窗口内只有一个调用方返回 'OK'。
   * 使用 SET key token PX ttl NX —— 原子且自带过期，避免持有者崩溃后死锁。
   */
  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * 释放锁（DistributedLock.release）：仅当持有者（token 匹配）才删除，避免误删他人持有的锁。
   * 通过 Lua 脚本保证"比较+删除"的原子性。
   */
  async release(key: string, token: string): Promise<void> {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.client.eval(script, 1, key, token);
  }
}
