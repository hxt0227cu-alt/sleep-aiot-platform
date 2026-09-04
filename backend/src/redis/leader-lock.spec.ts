import { LeaderLockService } from './leader-lock.service';
import { DistributedLock } from './contracts';

/**
 * 内存版分布式锁：模拟 Redis SET NX 语义（同一 key 同一时刻只能被一个 token 持有）。
 */
class InMemoryLock implements DistributedLock {
  private store = new Map<string, string>();

  acquire(key: string, token: string): Promise<boolean> {
    if (this.store.has(key)) return Promise.resolve(false);
    this.store.set(key, token);
    return Promise.resolve(true);
  }

  release(key: string, token: string): Promise<void> {
    if (this.store.get(key) === token) this.store.delete(key);
    return Promise.resolve();
  }
}

describe('LeaderLockService（ADR-015 定时器协调）', () => {
  it('并发调用下，job 同一时刻至多一个副本在执行（互斥）', async () => {
    const lock = new InMemoryLock();
    const replicaA = new LeaderLockService(lock);
    const replicaB = new LeaderLockService(lock);

    let concurrent = 0;
    let maxConcurrent = 0;
    const job = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
    };

    // 两个副本各自周期性触发（模拟多副本 setInterval 同时到点）
    await Promise.all([
      replicaA.runIfLeader('timer:check', 10000, job),
      replicaB.runIfLeader('timer:check', 10000, job),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it('锁释放后，后续调用可以再次获得执行权', async () => {
    const lock = new InMemoryLock();
    const svc = new LeaderLockService(lock);
    let runs = 0;
    const job = () => {
      runs++;
    };

    const r1 = await svc.runIfLeader('timer:check', 10000, job);
    const r2 = await svc.runIfLeader('timer:check', 10000, job);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(runs).toBe(2);
  });

  it('不同 lockKey 互不影响（各自独立执行）', async () => {
    const lock = new InMemoryLock();
    const svc = new LeaderLockService(lock);
    let runsA = 0;
    let runsB = 0;

    await Promise.all([
      svc.runIfLeader('timer:a', 10000, () => {
        runsA++;
      }),
      svc.runIfLeader('timer:b', 10000, () => {
        runsB++;
      }),
    ]);

    expect(runsA).toBe(1);
    expect(runsB).toBe(1);
  });

  it('高频并发（20 个副本同时到点）下仅 1 个执行，杜绝重复执行', async () => {
    const lock = new InMemoryLock();
    const replicaA = new LeaderLockService(lock);
    const replicaB = new LeaderLockService(lock);

    let concurrent = 0;
    let maxConcurrent = 0;
    let total = 0;
    const job = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 2));
      concurrent--;
      total++;
    };

    // 20 个副本的定时器在同一时刻同时触发
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? replicaA : replicaB).runIfLeader(
          'timer:check',
          10000,
          job,
        ),
      ),
    );

    // 这正是 ADR-015 要的：N 副本并发只产生 1 次执行（而非 N 次重复写库）
    expect(maxConcurrent).toBe(1);
    expect(total).toBe(1);
  });
});
