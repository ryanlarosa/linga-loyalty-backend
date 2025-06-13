// routes/stores.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/admin/stores - Get all stores
router.get("/", async (req, res) => {
  try {
    const storesQuery = `SELECT * FROM stores ORDER BY name ASC;`;
    const { rows } = await pool.query(storesQuery);
    res.json(rows);
  } catch (error) {
    console.error("ADMIN GET STORES ERROR:", error);
    res.status(500).json({ message: "Server error while fetching stores." });
  }
});

// POST /api/admin/stores - Create a new store
router.post("/", async (req, res) => {
  const { name, linga_store_id, is_default_for_new_users } = req.body;
  if (!name || !linga_store_id) {
    return res
      .status(400)
      .json({ message: "Name and Linga Store ID are required." });
  }
  try {
    const newStoreQuery = `
      INSERT INTO stores (name, linga_store_id, is_default_for_new_users) 
      VALUES ($1, $2, $3) 
      RETURNING *;
    `;
    const { rows } = await pool.query(newStoreQuery, [
      name,
      linga_store_id,
      is_default_for_new_users || false,
    ]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("ADMIN CREATE STORE ERROR:", error);
    res.status(500).json({ message: "Server error creating store." });
  }
});

// PUT /api/admin/stores/:id - Update an existing store
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, linga_store_id, is_default_for_new_users } = req.body;
  if (!name || !linga_store_id) {
    return res
      .status(400)
      .json({ message: "Name and Linga Store ID are required." });
  }
  try {
    const updateStoreQuery = `
      UPDATE stores 
      SET name = $1, linga_store_id = $2, is_default_for_new_users = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING *;
    `;
    const { rows } = await pool.query(updateStoreQuery, [
      name,
      linga_store_id,
      is_default_for_new_users,
      id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Store not found." });
    }
    res.status(200).json(rows[0]);
  } catch (error) {
    console.error("ADMIN UPDATE STORE ERROR:", error);
    res.status(500).json({ message: "Server error updating store." });
  }
});

// DELETE /api/admin/stores/:id - Delete a store
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const deleteStoreQuery = "DELETE FROM stores WHERE id = $1 RETURNING *;";
    const { rows } = await pool.query(deleteStoreQuery, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Store not found." });
    }
    res
      .status(200)
      .json({ message: `Store "${rows[0].name}" deleted successfully.` });
  } catch (error) {
    console.error("ADMIN DELETE STORE ERROR:", error);
    res.status(500).json({ message: "Server error deleting store." });
  }
});

module.exports = router;
