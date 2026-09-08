import { computeConnectionLimit, requiresPgBouncer } from './connection-budget';

describe('数据库连接预算（ADR-016）', () => {
  describe('computeConnectionLimit', () => {
    it('默认参数下，20 副本共享 100 连接（预留 20）→ 每副本上限 4', () => {
      expect(
        computeConnectionLimit({
          pgMaxConnections: 100,
          reserved: 20,
          maxReplicas: 20,
        }),
      ).toBe(4);
    });

    it('副本数越多，每副本上限越低（总和恒定不越界）', () => {
      const few = computeConnectionLimit({
        pgMaxConnections: 100,
        reserved: 20,
        maxReplicas: 10,
      });
      const many = computeConnectionLimit({
        pgMaxConnections: 100,
        reserved: 20,
        maxReplicas: 40,
      });
      expect(few).toBe(8);
      expect(many).toBe(2);
      // 最坏情况：40 副本 × 2 = 80 <= 100 - 20
      expect(many * 40).toBeLessThanOrEqual(80);
    });

    it('下限保护：即使算出来为负也至少返回 1', () => {
      expect(
        computeConnectionLimit({
          pgMaxConnections: 10,
          reserved: 20,
          maxReplicas: 5,
        }),
      ).toBe(1);
    });
  });

  describe('requiresPgBouncer', () => {
    it('每副本上限 < 2 时强制要求 PgBouncer', () => {
      expect(requiresPgBouncer(1)).toBe(true);
      expect(requiresPgBouncer(2)).toBe(false);
    });
  });
});
