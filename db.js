// db.js
const { Pool } = require("pg");

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

// Test the connection
pool.query("SELECT NOW()", (err, dbRes) => {
  if (err) {
    console.error("🔴 Error connecting to PostgreSQL database:", err.stack);
  } else {
    console.log(
      "✅ Successfully connected to PostgreSQL database. Current time from DB:",
      dbRes.rows[0].now
    );
  }
});

module.exports = pool;
