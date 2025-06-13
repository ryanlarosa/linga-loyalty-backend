// routes/webhook.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// POST /webhook/linga - This is where Linga POS will send transaction data
router.post("/linga", async (req, res) => {
  console.log("✅ Webhook received from Linga.");

  // Destructure all the data we expect from the Linga webhook payload
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

  // If there's no customer ID or order ID, we can't process it.
  if (!lingaOrderId || !customer) {
    return res
      .status(200)
      .json({
        message: "Webhook received, but missing order or customer ID. Ignored.",
      });
  }

  // Determine the amount to use for calculating points
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

  // Calculate points based on your business logic (e.g., 1 point per 10 AED)
  let pointsEarned = 0;
  if (totalAmountForPoints !== null && totalAmountForPoints > 0) {
    pointsEarned = Math.floor(totalAmountForPoints / 10);
  }

  // Don't do anything if no points were earned
  if (pointsEarned <= 0) {
    return res
      .status(200)
      .json({ message: "Webhook received, but no points earned." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Log the transaction in the transactions table
    const insertTransactionQuery = `
            INSERT INTO transactions (linga_order_id, total_amount, customer_identifier, transaction_time, raw_payload, points_earned, linga_store_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            ON CONFLICT (linga_order_id) DO NOTHING;
        `;
    await client.query(insertTransactionQuery, [
      lingaOrderId,
      totalAmountForPoints,
      lingaCustomerIdFromWebhook,
      transactionTime,
      rawPayload,
      pointsEarned,
      lingaStoreIdFromWebhook,
    ]);

    // Update the user's total points balance
    const updateUserPointsQuery = `
            UPDATE users 
            SET total_loyalty_points = total_loyalty_points + $1, updated_at = NOW() 
            WHERE linga_customer_id = $2;
        `;
    await client.query(updateUserPointsQuery, [
      pointsEarned,
      lingaCustomerIdFromWebhook,
    ]);

    await client.query("COMMIT");
    console.log(
      `Processed webhook for Order ID ${lingaOrderId}. Awarded ${pointsEarned} points.`
    );
    res.status(200).json({ message: "Webhook received and data processed." });
  } catch (dbError) {
    await client.query("ROLLBACK");
    console.error("Webhook: Error processing database update:", dbError.stack);
    // It's important to still send a 200 status so Linga doesn't keep retrying a failed webhook
    res
      .status(200)
      .json({
        message: "Webhook received, but an internal database error occurred.",
      });
  } finally {
    client.release();
  }
});

module.exports = router;
