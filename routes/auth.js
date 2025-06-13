// routes/auth.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const axios = require("axios");

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER || "it@eatx.com",
    pass: process.env.EMAIL_PASS || "qvgqetyoglhtckvd",
  },
});

router.post("/register", async (req, res) => {
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

router.post("/login", async (req, res) => {
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

router.post("/request-password-reset", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: "Email address is required." });
  }

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
      email.toLowerCase(),
    ]);
    if (rows.length === 0) {
      return res.status(200).json({
        message: "If a matching account was found, an OTP has been sent.",
      });
    }
    const user = rows[0];

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const tokenExpires = new Date(Date.now() + 600000); // OTP valid for 10 minutes

    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    await pool.query(
      "UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3",
      [hashedOtp, tokenExpires, user.id]
    );

    const mailOptions = {
      from: '"PerkX Support" <support@perkx.app>',
      to: user.email,
      subject: "Your PerkX Password Reset Code",
      html: `<div style="font-family: Arial, sans-serif; line-height: 1.6;"><h2>Password Reset Code</h2><p>A password reset was requested for your PerkX account. Please use the following One-Time Password (OTP) to proceed.</p><p style="font-size: 24px; font-weight: bold; letter-spacing: 5px; text-align: center; background: #f0f0f0; padding: 10px; border-radius: 5px;">${otp}</p><p>This code will expire in 10 minutes.</p><p>If you did not request this, please ignore this email.</p></div>`,
    };
    await transporter.sendMail(mailOptions);

    res.status(200).json({
      message: "If a matching account was found, an OTP has been sent.",
    });
  } catch (error) {
    console.error("REQUEST PASSWORD RESET ERROR:", error);
    res.status(500).json({ message: "An error occurred on the server." });
  }
});

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ message: "Email and OTP are required." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND password_reset_expires > NOW()",
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        message: "Invalid OTP or request has expired. Please try again.",
      });
    }
    const user = rows[0];

    const isMatch = await bcrypt.compare(otp, user.password_reset_token);
    if (!isMatch) {
      return res
        .status(400)
        .json({ message: "Invalid OTP. Please check the code and try again." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpires = new Date(Date.now() + 600000); // 10 minutes for final step

    await pool.query(
      "UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3",
      [resetToken, resetTokenExpires, user.id]
    );

    res.status(200).json({ message: "OTP verified.", resetToken: resetToken });
  } catch (error) {
    console.error("VERIFY OTP ERROR:", error);
    res.status(500).json({ message: "An error occurred on the server." });
  }
});
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res
      .status(400)
      .json({ message: "Token and new password are required." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()",
      [token]
    );

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ message: "Password reset token is invalid or has expired." });
    }
    const user = rows[0];

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await pool.query(
      "UPDATE users SET hashed_password = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2",
      [hashedPassword, user.id]
    );

    res
      .status(200)
      .json({ message: "Your password has been successfully reset." });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);
    res.status(500).json({ message: "An error occurred on the server." });
  }
});

module.exports = router;
