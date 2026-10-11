// Minimal environment so config loads in tests. Integration tests override DATABASE_URL.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
process.env.DATABASE_SSL = 'disable';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.FRONTEND_URL = 'http://localhost:5173';
