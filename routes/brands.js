// routes/brands.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/brands - Get list of all active brands for the mobile app
router.get("/", async (req, res) => {
  try {
    const brandsQuery = `
      SELECT * FROM brands 
      WHERE is_active = TRUE 
      ORDER BY sort_order ASC, name ASC;
    `;
    const { rows } = await pool.query(brandsQuery);
    res.json(rows);
  } catch (error) {
    console.error("PUBLIC GET BRANDS ERROR:", error);
    res.status(500).json({ message: "Server error while fetching brands." });
  }
});

module.exports = router;
