// routes/rewards.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // Assumes you have created the db.js file

// GET /api/rewards - Get list of all active rewards
router.get("/", async (req, res) => {
  try {
    const rewardsQuery = `
      SELECT id, name, description, points_cost, image_url, is_active 
      FROM rewards 
      WHERE is_active = TRUE 
      ORDER BY points_cost ASC;
    `;
    const { rows } = await pool.query(rewardsQuery);
    res.json(rows);
  } catch (error) {
    console.error("PUBLIC GET REWARDS ERROR:", error);
    res.status(500).json({ message: "Server error while fetching rewards." });
  }
});

module.exports = router;
