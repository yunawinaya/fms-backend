const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

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

app.post("/api/folders", async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    const currentDate = new Date();

    // Insert the new folder into the database
    const result = await pool.query(
      "INSERT INTO folders (name, date_created, last_modified, parent_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, currentDate, currentDate, parent_id]
    );

    const newFolder = result.rows[0];
    res.status(201).json(newFolder);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Set up multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Save files in the 'uploads' directory
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });

// Endpoint to upload files
app.post("/api/files", upload.single("file"), async (req, res) => {
  try {
    const { folder_id } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // File metadata
    const filePath = file.path;
    const fileType = path.extname(file.originalname).substring(1);
    const fileSize = file.size;

    // Insert file metadata into the database
    const result = await pool.query(
      "INSERT INTO files (name, file_type, size, date_created, last_modified, folder_id, path) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [
        file.originalname,
        fileType,
        fileSize,
        new Date(),
        new Date(),
        folder_id,
        filePath,
      ]
    );

    const newFile = result.rows[0];
    res.status(201).json(newFile);
  } catch (err) {
    console.error("Error processing file upload:", err);
    res.status(500).json({ error: err.message || "Server Error" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
