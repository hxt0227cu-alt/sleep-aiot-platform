require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const adapter = new PrismaPg(pool);
const pc = new PrismaClient({ adapter });

pc.$connect()
  .then(() => {
    console.log('Connected to database!');
    return pc.$disconnect();
  })
  .catch(e => {
    console.error('Connection error:', e);
    process.exit(1);
  });
