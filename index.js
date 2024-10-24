const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    // Ensure the directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage: storage });

// Routes
app.get("/", (req, res) => res.send("File Management System"));

app.get("/api/folders", async (req, res) => {
  try {
    const foldersResult = await pool.query("SELECT * FROM folders");
    const folders = foldersResult.rows;

    const filesResult = await pool.query("SELECT * FROM files");
    const files = filesResult.rows;

    const folderMap = new Map();
    folders.forEach((folder) => {
      folder.children = [];
      folder.files = [];
      folderMap.set(folder.id, folder);
    });

    files.forEach((file) => {
      const folder = folderMap.get(file.folder_id);
      if (folder) {
        folder.files.push(file);
      }
    });

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

// File upload route
app.post("/api/files", upload.single("file"), async (req, res) => {
  try {
    const { folder_id } = req.body;
    const { filename, originalname, size } = req.file;
    const currentDate = new Date();

    const result = await pool.query(
      "INSERT INTO files (name, file_type, size, date_created, last_modified, folder_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [
        originalname,
        path.extname(originalname).substring(1),
        size,
        currentDate,
        currentDate,
        folder_id,
      ]
    );

    const newFile = result.rows[0];
    res.status(201).json(newFile);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
