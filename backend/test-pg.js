require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host: '127.0.0.1',
  port: 5432,
  database: 'sleep_lamp',
  user: 'hxt',
  password: process.env.POSTGRES_PASSWORD
});

client.connect()
  .then(() => {
    console.log('Connected to database!');
    return client.query('SELECT 1');
  })
  .then(res => {
    console.log('Query result:', res.rows);
    return client.end();
  })
  .catch(e => {
    console.error('Connection error:', e.message);
    process.exit(1);
  });
