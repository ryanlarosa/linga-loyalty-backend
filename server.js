// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const pool = require("./db"); // Import the central db connection

// --- Import Routers ---
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const userRoutes = require("./routes/user");
const webhookRoutes = require("./routes/webhook");
const rewardRoutes = require("./routes/rewards"); // Public route for fetching rewards
const storeRoutes = require("./routes/stores");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware Setup ---
app.use(cors());
app.use(express.json());

// --- Middleware Definitions ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, userPayload) => {
    if (err) {
      console.log("Auth middleware: Token verification failed.", err.message);
      return res.sendStatus(403);
    }
    req.user = userPayload;
    next();
  });
};

const isAdmin = (req, res, next) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey && adminKey === process.env.ADMIN_SECRET_KEY) {
    next();
  } else {
    res
      .status(403)
      .json({ message: "Forbidden: Administrator access required." });
  }
};

// --- Mount Routers ---
app.get("/", (req, res) => {
  res.send("PerkX Loyalty App Backend is alive and running!");
});

// Public routes that anyone can access
app.use("/api/rewards", rewardRoutes); // e.g., GET /api/rewards
app.use("/api/auth", authRoutes); // e.g., POST /api/auth/login

// User routes that require a logged-in user
app.use("/api/users", authenticateToken, userRoutes); // e.g., GET /api/users/me

// Admin routes that require the admin secret key
app.use("/api/admin", isAdmin, adminRoutes); // e.g., GET /api/admin/users
app.use("/api/admin/stores", isAdmin, storeRoutes);
// Webhook routes that do not have auth
app.use("/webhook", webhookRoutes); // e.g., POST /webhook/linga

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Node.js server is listening on port ${PORT}`);
});
