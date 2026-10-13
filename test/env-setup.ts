/** Loaded before any module reads process.env. Raises rate limits past what a test run can hit (limiters stay ON) and runs jobs inline. */
process.env.NODE_ENV ??= 'test';
process.env.AUTH_RATE_LIMIT_MAX ??= '100000';
process.env.RATE_LIMIT_MAX ??= '1000000';
process.env.JOBS_MODE ??= 'inline';
process.env.MAIL_ENABLED ??= 'false';
process.env.DATABASE_URL ??= 'postgres://storekeeper:storekeeper@localhost:5432/storekeeper';
process.env.REDIS_URL ??= 'redis://localhost:6379';
