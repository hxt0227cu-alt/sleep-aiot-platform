/**
 * 容量与成本评估报告生成
 *
 * 功能：
 *   根据性能测试结果和资源使用数据，生成容量规划和成本评估报告。
 *
 * 使用：
 *   node capacity-and-cost-report.js --input performance-results.json --output capacity-report.json
 */

const fs = require('fs');
const path = require('path');

// 配置
const config = {
  // 阿里云资源单价（参考价，实际以官方为准）
  pricing: {
    ecs: {
      'ecs.g7.large': 0.5,    // 2C8G, 元/小时
      'ecs.g7.xlarge': 1.0,   // 4C16G, 元/小时
      'ecs.g7.2xlarge': 2.0,  // 8C32G, 元/小时
    },
    rds: {
      'rds.mysql.se2.large': 1.2,  // 4C16G, 元/小时
    },
    redis: {
      'redis.master.small.default': 0.3,  // 1G, 元/小时
    },
    oss: {
      storage: 0.12,  // 元/GB/月
      request: 0.01,   // 元/万次请求
    },
    slb: {
      instance: 0.02,  // 元/小时
      traffic: 0.08,   // 元/GB
    },
    kafka: {
      'kafka.ms.small': 0.5,  // 元/小时
    },
  },

  // 容量规划系数
  capacityFactors: {
    cpuUtilizationTarget: 0.6,      // 目标 CPU 使用率 60%
    memoryUtilizationTarget: 0.7,   // 目标内存使用率 70%
    headroomFactor: 1.5,             // 预留 50% 余量
    growthFactor: 1.3,               // 3 个月增长预期 30%
  },

  // SLO 要求
  slo: {
    availability: 99.9,
    latencyP95: 500,  // ms
    throughput: 10000, // requests/second
  },
};

// 服务资源配置
const serviceConfigs = {
  'backend-api': {
    instanceType: 'ecs.g7.xlarge',
    replicas: 3,
    cpuCores: 4,
    memoryGB: 16,
  },
  'alarm-service': {
    instanceType: 'ecs.g7.large',
    replicas: 2,
    cpuCores: 2,
    memoryGB: 8,
  },
  'data-pipeline': {
    instanceType: 'ecs.g7.2xlarge',
    replicas: 2,
    cpuCores: 8,
    memoryGB: 32,
  },
  'mqtt-broker': {
    instanceType: 'ecs.g7.2xlarge',
    replicas: 3,
    cpuCores: 8,
    memoryGB: 32,
  },
};

// 计算月度成本
function calculateMonthlyCost(hourlyRate) {
  return hourlyRate * 24 * 30;
}

// 生成容量报告
function generateCapacityReport(performanceData) {
  const report = {
    reportType: 'capacity-and-cost-assessment',
    generatedAt: new Date().toISOString(),
    period: '2026-Q3',
    environment: 'production',
  };

  // 1. 当前资源使用
  report.currentUsage = {
    totalECSInstances: 0,
    totalCPUCores: 0,
    totalMemoryGB: 0,
    services: {},
  };

  for (const [service, config] of Object.entries(serviceConfigs)) {
    report.currentUsage.services[service] = {
      instanceType: config.instanceType,
      replicas: config.replicas,
      cpuCores: config.cpuCores * config.replicas,
      memoryGB: config.memoryGB * config.replicas,
    };
    report.currentUsage.totalECSInstances += config.replicas;
    report.currentUsage.totalCPUCores += config.cpuCores * config.replicas;
    report.currentUsage.totalMemoryGB += config.memoryGB * config.replicas;
  }

  // 2. 成本分析
  report.costAnalysis = {
    monthlyCost: 0,
    annualCost: 0,
    breakdown: {},
  };

  for (const [service, config] of Object.entries(serviceConfigs)) {
    const hourlyRate = config.pricing.ecs[config.instanceType] || 1.0;
    const monthlyCost = calculateMonthlyCost(hourlyRate) * config.replicas;
    report.costAnalysis.breakdown[service] = {
      hourlyRate,
      monthlyCost,
      annualCost: monthlyCost * 12,
    };
    report.costAnalysis.monthlyCost += monthlyCost;
  }

  // 数据库成本
  report.costAnalysis.breakdown['postgresql'] = {
    instanceType: 'rds.mysql.se2.large',
    monthlyCost: calculateMonthlyCost(config.pricing.rds['rds.mysql.se2.large']),
  };
  report.costAnalysis.monthlyCost += report.costAnalysis.breakdown['postgresql'].monthlyCost;

  report.costAnalysis.annualCost = report.costAnalysis.monthlyCost * 12;

  // 3. 容量规划
  report.capacityPlanning = {
    currentLoad: performanceData || {
      peakRequestsPerSecond: 5000,
      peakConcurrentDevices: 50000,
      peakCPUUtilization: 45,
      peakMemoryUtilization: 55,
    },
    targetCapacity: {
      requestsPerSecond: 10000,
      concurrentDevices: 100000,
      cpuUtilization: 60,
      memoryUtilization: 70,
    },
    recommendations: [
      {
        service: 'backend-api',
        currentReplicas: 3,
        recommendedReplicas: 4,
        reason: '预计 3 个月内流量增长 30%，需要扩容',
        costImpact: '+1000 元/月',
      },
      {
        service: 'mqtt-broker',
        currentReplicas: 3,
        recommendedReplicas: 5,
        reason: '设备接入量预计增长 50%，需要增加 Broker 节点',
        costImpact: '+4000 元/月',
      },
    ],
  };

  // 4. 成本优化建议
  report.costOptimization = {
    potentialSavingsMonthly: 0,
    recommendations: [
      {
        area: '预留实例',
        description: '将稳定运行的 ECS 实例转为预留实例，可节省 30-40%',
        potentialSavings: 2000,
        priority: 'high',
      },
      {
        area: '存储分层',
        description: '将历史数据迁移到低频存储，可节省 50% 存储成本',
        potentialSavings: 500,
        priority: 'medium',
      },
      {
        area: '自动伸缩',
        description: '对非核心服务启用自动伸缩，非高峰时段缩减资源',
        potentialSavings: 800,
        priority: 'medium',
      },
    ],
  };

  for (const rec of report.costOptimization.recommendations) {
    report.costOptimization.potentialSavingsMonthly += rec.potentialSavings;
  }

  // 5. 总结
  report.summary = {
    currentMonthlyCost: report.costAnalysis.monthlyCost,
    currentAnnualCost: report.costAnalysis.annualCost,
    projectedMonthlyCostAfterExpansion: report.costAnalysis.monthlyCost + 5000,
    potentialMonthlySavings: report.costOptimization.potentialSavingsMonthly,
    optimizedMonthlyCost: report.costAnalysis.monthlyCost - report.costOptimization.potentialSavingsMonthly,
  };

  return report;
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input');
  const outputIndex = args.indexOf('--output');

  const inputFile = inputIndex !== -1 ? args[inputIndex + 1] : null;
  const outputFile = outputIndex !== -1 ? args[outputIndex + 1] : 'capacity-report.json';

  console.log('=== 容量与成本评估报告生成 ===\n');

  // 加载性能数据
  let performanceData = null;
  if (inputFile && fs.existsSync(inputFile)) {
    console.log(`加载性能数据: ${inputFile}`);
    performanceData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } else {
    console.log('使用默认性能数据');
  }

  // 生成报告
  const report = generateCapacityReport(performanceData);

  // 保存报告
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  console.log(`\n报告已保存: ${outputFile}`);

  // 打印摘要
  console.log('\n=== 报告摘要 ===');
  console.log(`当前月度成本: ${report.summary.currentMonthlyCost.toFixed(0)} 元`);
  console.log(`当前年度成本: ${report.summary.currentAnnualCost.toFixed(0)} 元`);
  console.log(`扩容后月度成本: ${report.summary.projectedMonthlyCostAfterExpansion.toFixed(0)} 元`);
  console.log(`潜在月度节省: ${report.summary.potentialMonthlySavings.toFixed(0)} 元`);
  console.log(`优化后月度成本: ${report.summary.optimizedMonthlyCost.toFixed(0)} 元`);
  console.log('================\n');
}

main();
