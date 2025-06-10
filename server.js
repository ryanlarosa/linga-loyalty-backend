// server.js
require("dotenv").config(); // Load .env file variables for local development (must be at the very top)

const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000; // Render will set process.env.PORT

// --- Essential Environment Variable Checks ---
const requiredEnvVars = [
  "DATABASE_URL",
  "JWT_SECRET",
  "LINGA_API_KEY",
  "LINGA_ACCOUNT_ID",
];
let missingVars = [];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    missingVars.push(varName);
  }
});

if (missingVars.length > 0) {
  console.error(
    `FATAL ERROR: Missing required environment variables: ${missingVars.join(
      ", "
    )}`
  );
  console.error(
    "Please set them in your deployment environment or .env file for local development."
  );
  if (process.env.NODE_ENV === "production") {
    process.exit(1); // Exit if critical vars are missing in production
  }
}

// --- PostgreSQL Connection Pool Setup ---
const isProduction = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false, // SSL for production DBs on Render/Heroku
});

pool.query("SELECT NOW()", (err, dbRes) => {
  // Renamed res to dbRes
  if (err) {
    console.error("🔴 Error connecting to PostgreSQL database:", err.stack);
  } else {
    console.log(
      "✅ Successfully connected to PostgreSQL database. Current time from DB:",
      dbRes.rows[0].now
    );
  }
});
// --- End PostgreSQL Connection Setup ---

app.use(express.json());

// Simple GET route
app.get("/", (req, res) => {
  res.send("Loyalty App Backend is alive and running!");
});

// --- JWT Authentication Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) {
    console.log("Auth middleware: No token provided.");
    return res.sendStatus(401);
  }
  // process.env.JWT_SECRET is now guaranteed by the check at the top
  jwt.verify(token, process.env.JWT_SECRET, (err, userPayload) => {
    if (err) {
      console.log("Auth middleware: Token verification failed.", err.message);
      return res.sendStatus(403);
    }
    req.user = userPayload;
    console.log(
      "Auth middleware: Token verified for user ID:",
      req.user.userId,
      "(Name:",
      req.user.name + ")"
    );
    next();
  });
};
// --- End JWT Authentication Middleware ---

// --- User Registration Endpoint ---
app.post("/api/auth/register", async (req, res) => {
  const { firstName, lastName, phoneNumber, email, password } = req.body;

  // Get these from environment variables
  const LINGA_API_KEY = process.env.LINGA_API_KEY;
  const LINGA_ACCOUNT_ID = process.env.LINGA_ACCOUNT_ID;
  // You can also make LINGA_CUSTOMER_API_URL an env var if it might change
  const LINGA_CUSTOMER_API_URL =
    process.env.LINGA_CUSTOMER_API_URL ||
    "https://api.lingaros.com/v1/lingapos/customer";

  if (!firstName || !phoneNumber || !password || !email) {
    return res.status(400).json({
      message: "First name, phone number, email, and password are required.",
    });
  }
  const emailRegex = /\S+@\S+\.\S+/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: "Invalid email format." });
  }

  let lingaCustomerId = null;
  let defaultLingaStoreIds = [];

  try {
    console.log("Register: Fetching default store IDs...");
    const defaultStoresResult = await pool.query(
      "SELECT linga_store_id FROM stores WHERE is_default_for_new_users = TRUE"
    );
    defaultLingaStoreIds = defaultStoresResult.rows.map(
      (store) => store.linga_store_id
    );
    console.log(
      "Register: Default Linga Store IDs to assign:",
      defaultLingaStoreIds
    );

    console.log(
      `Register: Attempting to POST customer to LingaPOS: Phone - ${phoneNumber}, Email - ${email}`
    );
    const lingaPayload = {
      firstName: firstName,
      lastName: lastName || "",
      phoneNumber: phoneNumber,
      emailId: email,
      stores: defaultLingaStoreIds,
      account: LINGA_ACCOUNT_ID,
    };
    console.log(
      "Register: Payload to Linga:",
      JSON.stringify(lingaPayload, null, 2)
    );

    const lingaResponse = await axios.post(
      LINGA_CUSTOMER_API_URL,
      lingaPayload,
      {
        headers: { apikey: LINGA_API_KEY, "Content-Type": "application/json" },
        timeout: 10000, // Good to have a timeout
      }
    );

    if (
      lingaResponse.status === 200 &&
      lingaResponse.data &&
      lingaResponse.data.id
    ) {
      lingaCustomerId = lingaResponse.data.id;
      console.log(
        "Register: Successfully POSTed to Linga. Linga Customer ID:",
        lingaCustomerId
      );
    } else {
      console.error(
        "Register: Linga API POST status " +
          lingaResponse.status +
          ", but response missing 'id' or not as expected."
      );
      console.error(
        "Register: Linga response data:",
        JSON.stringify(lingaResponse.data, null, 2)
      );
      return res.status(500).json({
        message:
          "Linga API did not provide a clear customer ID after creation (unexpected success response).",
      });
    }
  } catch (lingaError) {
    if (lingaError.response) {
      console.error(
        "Register: Error from Linga Customer API:",
        lingaError.response.status,
        JSON.stringify(lingaError.response.data, null, 2)
      );
      if (
        lingaError.response.status === 400 &&
        lingaError.response.data?.errors?.emailIdOrPhonenumber ===
          "Entered Email/phone number already present" &&
        lingaError.response.data.id
      ) {
        lingaCustomerId = lingaError.response.data.id;
        console.log(
          "Register: Linga indicated email/phone exists. Using existing Linga Customer ID:",
          lingaCustomerId
        );
      } else {
        const errorMessage = `Linga API Error (${
          lingaError.response.status
        }): ${JSON.stringify(lingaError.response.data || lingaError.message)}`;
        return res.status(500).json({ message: errorMessage });
      }
    } else {
      console.error(
        "Register: Error connecting to Linga Customer API:",
        lingaError.message
      );
      const errorMessage = `Network or other error calling Linga API: ${lingaError.message}`;
      return res.status(500).json({ message: errorMessage });
    }
  }

  if (!lingaCustomerId) {
    console.error(
      "Register: Failed to obtain a Linga Customer ID. Cannot create local user."
    );
    return res.status(500).json({
      message: "Failed to obtain a customer ID from Linga for linking.",
    });
  }

  try {
    const existingUserQuery =
      "SELECT id FROM users WHERE linga_customer_id = $1";
    const { rows: existingUserRows } = await pool.query(existingUserQuery, [
      lingaCustomerId,
    ]);
    if (existingUserRows.length > 0) {
      console.warn(
        `Register: Linga Customer ID ${lingaCustomerId} already exists locally (User ID: ${existingUserRows[0].id}). Registration aborted.`
      );
      return res.status(409).json({
        message:
          "This account (linked with Linga) is already registered in our loyalty program. Please try logging in.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const combinedName = `${firstName}${lastName ? " " + lastName : ""}`;
    const userEmailToStore = email.toLowerCase();
    const newUserQuery = `
      INSERT INTO users (name, phone_number, email, hashed_password, linga_customer_id, total_loyalty_points)
      VALUES ($1, $2, $3, $4, $5, 0)
      RETURNING id, name, phone_number, email, linga_customer_id, created_at;
    `;
    const dbResult = await pool.query(newUserQuery, [
      combinedName,
      phoneNumber,
      userEmailToStore,
      hashedPassword,
      lingaCustomerId,
    ]);
    const registeredUser = dbResult.rows[0];
    console.log(
      "Register: New user registered successfully in local DB:",
      registeredUser.id
    );
    res.status(201).json({
      message: "User registered successfully!",
      user: {
        id: registeredUser.id,
        name: registeredUser.name,
        phone_number: registeredUser.phone_number,
        email: registeredUser.email,
        linga_customer_id: registeredUser.linga_customer_id,
      },
    });
  } catch (dbError) {
    if (dbError.code === "23505") {
      let violatedField = dbError.constraint || "unique_constraint";
      console.warn(
        `Register DB Error: Unique constraint violation (${violatedField}) for user. Linga ID processed: ${lingaCustomerId}.`
      );
      let userMessage =
        "An account with this email or phone number already exists in our loyalty program.";
      if (violatedField.includes("email")) {
        userMessage =
          "This email address is already registered in our loyalty program.";
      } else if (violatedField.includes("phone_number")) {
        userMessage =
          "This phone number is already registered in our loyalty program.";
      }
      return res.status(409).json({ message: userMessage });
    }
    console.error(
      "Register: Error registering user in local DB:",
      dbError.stack
    );
    res.status(500).json({ message: "Error saving user to loyalty database." });
  }
});
// --- End User Registration Endpoint ---

// --- User Login Endpoint ---
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Email and password are required." });
  }
  try {
    const userQuery = "SELECT * FROM users WHERE email = $1";
    const { rows } = await pool.query(userQuery, [email.toLowerCase()]);
    if (rows.length === 0) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. User not found." });
    }
    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.hashed_password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Password incorrect." });
    }

    const jwtPayload = {
      userId: user.id,
      name: user.name,
      email: user.email,
      lingaCustomerId: user.linga_customer_id,
    };
    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    const userForResponse = {
      id: user.id,
      name: user.name,
      phone_number: user.phone_number,
      email: user.email,
      linga_customer_id: user.linga_customer_id,
      total_loyalty_points: user.total_loyalty_points,
    };
    console.log(
      "Backend /api/auth/login sending user object:",
      JSON.stringify(userForResponse, null, 2)
    );
    res.json({
      message: "Login successful!",
      token: token,
      user: userForResponse,
    });
  } catch (error) {
    console.error("Login: Error during login:", error.stack);
    res.status(500).json({ message: "Server error during login." });
  }
});
// --- End User Login Endpoint ---

// --- Get Logged-in User's Profile & Points (Protected Route) ---
app.get("/api/users/me", authenticateToken, async (req, res) => {
  // ... (logic as before, no direct env vars here) ...
  const loggedInUserId = req.user.userId;
  if (!loggedInUserId) {
    return res
      .status(403)
      .json({ message: "Authentication error: User ID not found in token." });
  }
  try {
    const userQuery = `SELECT id, name, phone_number, email, linga_customer_id, total_loyalty_points, created_at, updated_at FROM users WHERE id = $1;`;
    const { rows } = await pool.query(userQuery, [loggedInUserId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: "Server error fetching user profile." });
  }
});
// --- End Get Logged-in User's Profile & Points ---

// --- Get List of Active Rewards Endpoint ---
app.get("/api/rewards", async (req, res) => {
  // ... (logic as before) ...
  try {
    const rewardsQuery = `SELECT id, name, description, points_cost, image_url, is_active FROM rewards WHERE is_active = TRUE ORDER BY points_cost ASC;`;
    const { rows } = await pool.query(rewardsQuery);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Server error while fetching rewards." });
  }
});
// --- End Get List of Active Rewards Endpoint ---

// --- Redeem a Reward Endpoint (Protected) ---
app.post(
  "/api/rewards/:rewardId/redeem",
  authenticateToken,
  async (req, res) => {
    // ... (logic as before, uses client from pool) ...
    const { rewardId } = req.params;
    const userId = req.user.userId;
    if (!rewardId || isNaN(parseInt(rewardId))) {
      return res.status(400).json({ message: "Valid Reward ID is required." });
    }
    const parsedRewardId = parseInt(rewardId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rewardQuery =
        "SELECT points_cost, name FROM rewards WHERE id = $1 AND is_active = TRUE FOR UPDATE";
      const rewardResult = await client.query(rewardQuery, [parsedRewardId]);
      if (rewardResult.rows.length === 0) {
        await client.query("ROLLBACK");
        client.release();
        return res
          .status(404)
          .json({ message: "Reward not found or is not active." });
      }
      const rewardToRedeem = rewardResult.rows[0];
      const userQuery =
        "SELECT total_loyalty_points FROM users WHERE id = $1 FOR UPDATE";
      const userResult = await client.query(userQuery, [userId]);
      if (userResult.rows.length === 0) {
        await client.query("ROLLBACK");
        client.release();
        return res
          .status(404)
          .json({ message: "Authenticated user not found." });
      }
      const currentUser = userResult.rows[0];
      if (currentUser.total_loyalty_points < rewardToRedeem.points_cost) {
        await client.query("ROLLBACK");
        client.release();
        return res.status(400).json({ message: "Insufficient points." });
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
      res
        .status(500)
        .json({ message: "Server error during reward redemption." });
    } finally {
      client.release();
    }
  }
);
// --- End Redeem a Reward Endpoint ---

// --- Get User's Points History Endpoint (Protected) ---
app.get("/api/users/me/point-history", authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const lingaCustomerId = req.user.lingaCustomerId;
  const { limit } = req.query; // <-- Get the optional 'limit' query parameter

  try {
    const earnedPointsQuery = `SELECT 'transaction_' || t.id AS event_id, 'earned' AS type, t.points_earned AS points, t.transaction_time AS date, COALESCE(s.name, t.linga_store_id, 'Unknown Store') AS store_name, 'Points from purchase at ' || COALESCE(s.name, t.linga_store_id, 'Unknown Store') || ' (Order: ' || t.linga_order_id || ')' AS description FROM transactions t LEFT JOIN stores s ON t.linga_store_id = s.linga_store_id WHERE t.customer_identifier = $1 AND t.points_earned > 0 `;
    const spentPointsQuery = `SELECT 'redemption_' || rdm.id AS event_id, 'redeemed' AS type, rdm.points_spent AS points, rdm.redeemed_at AS date, NULL AS store_name, 'Redeemed: ' || r.name AS description FROM redemptions rdm JOIN rewards r ON rdm.reward_id = r.id WHERE rdm.user_id = $1 `;

    let history = [];
    if (lingaCustomerId) {
      const earnedResult = await pool.query(earnedPointsQuery, [
        lingaCustomerId,
      ]);
      history = history.concat(earnedResult.rows);
    }
    const spentResult = await pool.query(spentPointsQuery, [userId]);
    history = history.concat(spentResult.rows);

    // Sort before limiting
    history.sort((a, b) => new Date(b.date) - new Date(a.date));

    // If a limit is provided, slice the array
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
// --- End Get User's Points History Endpoint ---

// --- Webhook Listener Endpoint ---
app.post("/webhook/linga", async (req, res) => {
  console.log("✅ Webhook received from Linga.");
  // ... (logic as before, ensure any keys it might use in future are from env) ...
  // For brevity, assuming this logic is stable and doesn't directly use the new env vars yet.
  // If it makes calls to other APIs that need keys, those should be from process.env too.
  const {
    saleUniqueId,
    id,
    paidAmount,
    netSales,
    dateCreated,
    customer,
    store,
  } = req.body;
  const lingaOrderId = saleUniqueId || id;
  let totalAmountForPoints = null;
  if (paidAmount !== undefined && paidAmount !== null) {
    totalAmountForPoints = parseFloat(paidAmount) / 100.0;
  } else if (netSales !== undefined && netSales !== null) {
    totalAmountForPoints = parseFloat(netSales) / 100.0;
  }
  const transactionTime = dateCreated || new Date().toISOString();
  const rawPayload = req.body;
  const lingaCustomerIdFromWebhook = customer;
  const lingaStoreIdFromWebhook = store;
  let pointsEarned = 0;
  if (totalAmountForPoints !== null && totalAmountForPoints > 0) {
    pointsEarned = Math.floor(totalAmountForPoints / 10);
  }
  if (!lingaOrderId) {
    return res
      .status(200)
      .json({ message: "Webhook received, but missing order ID." });
  }
  const insertTransactionQuery = `INSERT INTO transactions (linga_order_id, total_amount, customer_identifier, transaction_time, raw_payload, points_earned, linga_store_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (linga_order_id) DO NOTHING RETURNING id;`;
  const transactionValues = [
    lingaOrderId,
    totalAmountForPoints,
    lingaCustomerIdFromWebhook,
    transactionTime,
    rawPayload,
    pointsEarned,
    lingaStoreIdFromWebhook,
  ];
  try {
    await pool.query(insertTransactionQuery, transactionValues); // Simplified result check
    if (lingaCustomerIdFromWebhook && pointsEarned > 0) {
      const updateUserPointsQuery = `UPDATE users SET total_loyalty_points = total_loyalty_points + $1, updated_at = NOW() WHERE linga_customer_id = $2 RETURNING id;`;
      await pool.query(updateUserPointsQuery, [
        pointsEarned,
        lingaCustomerIdFromWebhook,
      ]); // Simplified result check
    }
    res.status(200).json({ message: "Webhook received and data processed." });
  } catch (dbError) {
    console.error("Webhook: Error processing:", dbError.stack);
    res.status(200).json({ message: "Webhook received, internal error." });
  }
});
// --- End Webhook Listener Endpoint ---

app.listen(PORT, () => {
  console.log(`Node.js server is listening on port ${PORT}`);
});
