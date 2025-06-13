// routes/user.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Note: The main server.js will apply the `authenticateToken` middleware before using this router.
// So, we can assume `req.user` is available in all these routes.

// GET /api/users/me - Get Logged-in User's Profile
router.get("/me", async (req, res) => {
  const loggedInUserId = req.user.userId;
  try {
    const userQuery = `SELECT id, name, phone_number, email, linga_customer_id, total_loyalty_points, created_at, updated_at FROM users WHERE id = $1;`;
    const { rows } = await pool.query(userQuery, [loggedInUserId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(
      `API: Error fetching profile for User ID ${loggedInUserId}:`,
      error.stack
    );
    res.status(500).json({ message: "Server error fetching user profile." });
  }
});

// GET /api/users/me/point-history - Get User's Points History
router.get("/me/point-history", async (req, res) => {
  const userId = req.user.userId;
  const lingaCustomerId = req.user.lingaCustomerId;
  const { limit } = req.query;

  try {
    const earnedPointsQuery = `
            SELECT 'transaction_' || t.id AS event_id, 'earned' AS type, t.points_earned AS points, t.transaction_time AS date, 
            COALESCE(s.name, t.linga_store_id, 'Unknown Store') AS source,
            'Points from purchase at ' || COALESCE(s.name, t.linga_store_id, 'Unknown Store') AS description 
            FROM transactions t LEFT JOIN stores s ON t.linga_store_id = s.linga_store_id 
            WHERE t.customer_identifier = $1 AND t.points_earned > 0`;
    const spentPointsQuery = `
            SELECT 'redemption_' || rdm.id AS event_id, 'redeemed' AS type, rdm.points_spent AS points, rdm.redeemed_at AS date, 
            r.name AS source,
            'Redeemed: ' || r.name AS description 
            FROM redemptions rdm JOIN rewards r ON rdm.reward_id = r.id 
            WHERE rdm.user_id = $1`;

    let history = [];
    if (lingaCustomerId) {
      const earnedResult = await pool.query(earnedPointsQuery, [
        lingaCustomerId,
      ]);
      history = history.concat(earnedResult.rows);
    }
    const spentResult = await pool.query(spentPointsQuery, [userId]);
    history = history.concat(spentResult.rows);

    history.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (limit) {
      history = history.slice(0, parseInt(limit, 10));
    }

    res.json(history);
  } catch (error) {
    console.error(
      `API: Error fetching points history for User ID ${userId}:`,
      error.stack
    );
    res
      .status(500)
      .json({ message: "Server error while fetching points history." });
  }
});

// POST /api/users/rewards/:rewardId/redeem - Redeem a Reward
// Note: We moved this to be under /api/users/ to signify a user action
router.post("/rewards/:rewardId/redeem", async (req, res) => {
  const { rewardId } = req.params;
  const userId = req.user.userId;
  const parsedRewardId = parseInt(rewardId);

  if (isNaN(parsedRewardId)) {
    return res.status(400).json({ message: "Valid Reward ID is required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rewardQuery =
      "SELECT points_cost, name FROM rewards WHERE id = $1 AND is_active = TRUE FOR UPDATE";
    const rewardResult = await client.query(rewardQuery, [parsedRewardId]);

    if (rewardResult.rows.length === 0) {
      throw new Error("Reward not found or is not active.");
    }
    const rewardToRedeem = rewardResult.rows[0];

    const userQuery =
      "SELECT total_loyalty_points FROM users WHERE id = $1 FOR UPDATE";
    const userResult = await client.query(userQuery, [userId]);
    const currentUser = userResult.rows[0];

    if (currentUser.total_loyalty_points < rewardToRedeem.points_cost) {
      throw new Error("Insufficient points.");
    }

    const newTotalPoints =
      currentUser.total_loyalty_points - rewardToRedeem.points_cost;
    await client.query(
      "UPDATE users SET total_loyalty_points = $1, updated_at = NOW() WHERE id = $2;",
      [newTotalPoints, userId]
    );

    const logRedemptionQuery = `INSERT INTO redemptions (user_id, reward_id, points_spent, status) VALUES ($1, $2, $3, 'REDEEMED') RETURNING id, redeemed_at;`;
    const redemptionResult = await client.query(logRedemptionQuery, [
      userId,
      parsedRewardId,
      rewardToRedeem.points_cost,
    ]);

    await client.query("COMMIT");
    res.status(200).json({
      message: `Reward "${rewardToRedeem.name}" redeemed successfully!`,
      newTotalPoints: newTotalPoints,
      redemptionDetails: redemptionResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("API: Error redeeming reward:", error.stack);
    if (error.message === "Insufficient points.") {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error during reward redemption." });
  } finally {
    client.release();
  }
});

module.exports = router;
