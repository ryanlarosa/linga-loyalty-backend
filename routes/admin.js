// routes/admin.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

//CREATE REWARD
router.post("/rewards", async (req, res) => {
  const { name, description, points_cost, image_url, is_active } = req.body;
  if (!name || !points_cost) {
    return res
      .status(400)
      .json({ message: "Name and points_cost are required." });
  }
  try {
    const newRewardQuery = `
      INSERT INTO rewards (name, description, points_cost, image_url, is_active) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING *;
    `;
    const { rows } = await pool.query(newRewardQuery, [
      name,
      description,
      points_cost,
      image_url,
      is_active === undefined ? true : is_active,
    ]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("ADMIN CREATE REWARD ERROR:", error);
    res.status(500).json({ message: "Server error creating reward." });
  }
});

//UPDATE A REWARD
router.put("/rewards/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, points_cost, image_url, is_active } = req.body;
  if (!name || !points_cost) {
    return res
      .status(400)
      .json({ message: "Name and points_cost are required." });
  }
  try {
    const updateRewardQuery = `
      UPDATE rewards 
      SET name = $1, description = $2, points_cost = $3, image_url = $4, is_active = $5, updated_at = NOW()
      WHERE id = $6
      RETURNING *;
    `;
    const { rows } = await pool.query(updateRewardQuery, [
      name,
      description,
      points_cost,
      image_url,
      is_active,
      id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Reward not found." });
    }
    res.status(200).json(rows[0]);
  } catch (error) {
    console.error("ADMIN UPDATE REWARD ERROR:", error);
    res.status(500).json({ message: "Server error updating reward." });
  }
});

//DELETE A REWARD
router.delete("/rewards/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const deleteRewardQuery = "DELETE FROM rewards WHERE id = $1 RETURNING *;";
    const { rows } = await pool.query(deleteRewardQuery, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Reward not found." });
    }
    res
      .status(200)
      .json({ message: `Reward "${rows[0].name}" deleted successfully.` });
  } catch (error) {
    console.error("ADMIN DELETE REWARD ERROR:", error);
    res.status(500).json({ message: "Server error deleting reward." });
  }
});

//FETCH USERS
router.get("/users", async (req, res) => {
  try {
    const usersQuery = `
      SELECT id, name, email, phone_number, total_loyalty_points, created_at 
      FROM users 
      ORDER BY created_at DESC;
    `;
    const { rows } = await pool.query(usersQuery);
    res.json(rows);
  } catch (error) {
    console.error("ADMIN GET USERS ERROR:", error);
    res.status(500).json({ message: "Server error while fetching users." });
  }
});

//ADJUST POINTS , not sure if we actually need this.
router.post("/users/:userId/adjust-points", async (req, res) => {
  "/api/admin/users/:userId/adjust-points",
    isAdmin,
    async (req, res) => {
      const { userId } = req.params;
      const { points, reason } = req.body;

      if (typeof points !== "number" || !reason) {
        return res.status(400).json({
          message:
            "A points value (number) and a reason (string) are required.",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Step 1: Update the user's total points
        const updateUserQuery = `
      UPDATE users 
      SET total_loyalty_points = total_loyalty_points + $1 
      WHERE id = $2 
      RETURNING *, total_loyalty_points AS new_total_points;
    `;
        const updatedUserResult = await client.query(updateUserQuery, [
          points,
          userId,
        ]);

        if (updatedUserResult.rows.length === 0) {
          throw new Error("User not found.");
        }

        const updatedUser = updatedUserResult.rows[0];

        // Step 2: Log this adjustment as a transaction for their history
        const transactionDescription = `Admin Adjustment: ${reason}`;
        const logTransactionQuery = `
      INSERT INTO transactions 
        (linga_order_id, total_amount, customer_identifier, transaction_time, raw_payload, points_earned, linga_store_id)
      VALUES 
        ($1, $2, $3, NOW(), $4, $5, $6);
    `;
        await client.query(logTransactionQuery, [
          `admin-adj-${Date.now()}`, // A unique ID for this adjustment
          0, // No sale amount for a manual adjustment
          updatedUser.linga_customer_id,
          { source: "admin_dashboard", reason: reason }, // The raw payload
          points, // The number of points, can be positive or negative
          "ADMIN", // A special store ID for admin actions
        ]);

        await client.query("COMMIT");
        res.status(200).json(updatedUser);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error("ADMIN ADJUST POINTS ERROR:", error);
        res
          .status(500)
          .json({ message: "Server error while adjusting points." });
      } finally {
        client.release();
      }
    };
});

router.get("/analytics", async (req, res) => {
  try {
    // We will run multiple queries in parallel for better performance
    const queries = [
      // Query 1: Get total number of users
      pool.query("SELECT COUNT(*) AS total_users FROM users;"),

      // Query 2: Get total points in circulation
      pool.query(
        "SELECT SUM(total_loyalty_points) AS total_points FROM users;"
      ),

      // Query 3: Get total number of redemptions
      pool.query("SELECT COUNT(*) AS total_redemptions FROM redemptions;"),

      // Query 4: Get the top 5 most redeemed rewards
      pool.query(`
        SELECT r.name, COUNT(rd.id) AS redemption_count 
        FROM redemptions rd 
        JOIN rewards r ON rd.reward_id = r.id 
        GROUP BY r.name 
        ORDER BY redemption_count DESC 
        LIMIT 5;
      `),

      // Query 5: Get the top 5 users by points
      pool.query(`
        SELECT name, total_loyalty_points 
        FROM users 
        ORDER BY total_loyalty_points DESC 
        LIMIT 5;
      `),
    ];

    const [
      totalUsersResult,
      totalPointsResult,
      totalRedemptionsResult,
      topRewardsResult,
      topUsersResult,
    ] = await Promise.all(queries);

    const analyticsData = {
      totalUsers: parseInt(totalUsersResult.rows[0].total_users, 10),
      totalPointsInCirculation:
        parseInt(totalPointsResult.rows[0].total_points, 10) || 0,
      totalRedemptions: parseInt(
        totalRedemptionsResult.rows[0].total_redemptions,
        10
      ),
      topRewards: topRewardsResult.rows,
      topUsers: topUsersResult.rows,
    };

    res.json(analyticsData);
  } catch (error) {
    console.error("ADMIN GET ANALYTICS ERROR:", error);
    res
      .status(500)
      .json({ message: "Server error while fetching analytics data." });
  }
});

module.exports = router;
