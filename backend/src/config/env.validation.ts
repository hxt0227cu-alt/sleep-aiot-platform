const requiredKeys = [
  'DATABASE_URL',
  'MQTT_BROKER_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = requiredKeys.filter(
    (key) => !String(config[key] || '').trim(),
  );
  if (!config.REDIS_URL && !config.REDIS_HOST) {
    missing.push('REDIS_URL' as (typeof requiredKeys)[number]);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${Array.from(new Set(missing)).join(', ')}`,
    );
  }

  if (config.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (String(config[key]).length < 32) {
        throw new Error(
          `${key} must contain at least 32 characters in production`,
        );
      }
    }
  }
  return config;
}
