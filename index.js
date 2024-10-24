const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Set up PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Routes
app.get("/", (req, res) => res.send("File Management System"));

app.get("/api/folders", async (req, res) => {
  try {
    // Fetch all folders
    const foldersResult = await pool.query("SELECT * FROM folders");
    const folders = foldersResult.rows;

    // Fetch all files
    const filesResult = await pool.query("SELECT * FROM files");
    const files = filesResult.rows;

    // Create a map to store folders by id
    const folderMap = new Map();
    folders.forEach((folder) => {
      folder.children = []; // Initialize children array for each folder
      folder.files = []; // Initialize files array for each folder
      folderMap.set(folder.id, folder);
    });

    // Assign files to their respective folders
    files.forEach((file) => {
      const folder = folderMap.get(file.folder_id);
      if (folder) {
        folder.files.push(file);
      }
    });

    // Nest folders based on parent_id
    const nestedFolders = [];
    folderMap.forEach((folder) => {
      if (folder.parent_id === null) {
        nestedFolders.push(folder);
      } else {
        const parentFolder = folderMap.get(folder.parent_id);
        if (parentFolder) {
          parentFolder.children.push(folder);
        }
      }
    });

    res.json(nestedFolders);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Additional routes for CRUD operations

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
