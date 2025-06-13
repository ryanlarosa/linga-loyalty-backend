// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const pool = require("./db"); // Import the central db connection

// --- Import ALL Your Routers ---
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const userRoutes = require("./routes/user");
const webhookRoutes = require("./routes/webhook");
const rewardRoutes = require("./routes/rewards");
const storeRoutes = require("./routes/stores");
const brandRoutes = require("./routes/brands"); // Admin brands

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware Setup ---
app.use(cors());
app.use(express.json());

// --- Middleware Definitions ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, userPayload) => {
    if (err) return res.sendStatus(403);
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
  res.send("PerkX Loyalty App Backend is alive!");
});

// Public routes
app.use("/api/rewards", rewardRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/brands", brandRoutes);

// User routes (needs login)
app.use("/api/users", authenticateToken, userRoutes);

// Admin routes (needs secret key)
app.use("/api/admin", isAdmin, adminRoutes);
app.use("/api/admin/stores", isAdmin, storeRoutes); // Added this from our recent work

// Webhook routes (no auth)
app.use("/webhook", webhookRoutes);

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Node.js server is listening on port ${PORT}`);
});
