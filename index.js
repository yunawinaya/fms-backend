const express = require("express");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const cors = require("cors");
const multer = require("multer");
const { Storage } = require("@google-cloud/storage");
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

const keyFilePath = path.join("/tmp", "gcloud-key.json");
const keyBase64 = process.env.GCLOUD_KEY_BASE64;
const keyDecoded = Buffer.from(keyBase64, "base64").toString("utf8");

fs.writeFileSync(keyFilePath, keyDecoded);

// Initialize Google Cloud Storage with the decoded key
const storage = new Storage({
  keyFilename: keyFilePath,
  projectId: process.env.GCLOUD_PROJECT_ID,
});

const bucket = storage.bucket(process.env.GCLOUD_STORAGE_BUCKET);

// Multer setup for file uploads (in memory storage)
const upload = multer({ storage: multer.memoryStorage() });

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

// Upload file to Google Cloud Storage and add entry to DB
app.post("/api/files", upload.single("file"), async (req, res) => {
  try {
    const { folder_id } = req.body;
    const file = req.file;
    const gcsFileName = `${Date.now()}-${file.originalname}`;
    const blob = bucket.file(gcsFileName);
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: file.mimetype,
      },
    });

    blobStream.on("error", (err) => {
      console.error(err);
      res.status(500).send("Error uploading file to Google Cloud Storage");
    });

    blobStream.on("finish", async () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;

      // Insert file record in the database
      const result = await pool.query(
        "INSERT INTO files (name, file_type, size, date_created, last_modified, folder_id, url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        [
          file.originalname,
          path.extname(file.originalname).substring(1),
          file.size,
          new Date(),
          new Date(),
          folder_id,
          publicUrl,
        ]
      );

      const newFile = result.rows[0];
      res.status(201).json(newFile);
    });

    blobStream.end(file.buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Delete file from Google Cloud Storage and database
app.delete("/api/files/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Retrieve the file information from the database
    const fileResult = await pool.query("SELECT * FROM files WHERE id = $1", [
      id,
    ]);
    const file = fileResult.rows[0];

    if (!file) {
      return res.status(404).send("File not found");
    }

    // Delete the file from Google Cloud Storage
    const gcsFile = bucket.file(file.url.split(`${bucket.name}/`)[1]);
    await gcsFile.delete();

    // Delete the file record from the database
    await pool.query("DELETE FROM files WHERE id = $1", [id]);

    res.status(200).send("File deleted successfully");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting file");
  }
});

// Delete folder and its contents from database and storage
app.delete("/api/folders/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Retrieve the folder's files
    const filesResult = await pool.query(
      "SELECT * FROM files WHERE folder_id = $1",
      [id]
    );
    const files = filesResult.rows;

    // Delete files from Google Cloud Storage
    for (const file of files) {
      const gcsFile = bucket.file(file.url.split(`${bucket.name}/`)[1]);
      await gcsFile.delete();
    }

    // Delete files from the database
    await pool.query("DELETE FROM files WHERE folder_id = $1", [id]);

    // Delete the folder from the database
    await pool.query("DELETE FROM folders WHERE id = $1", [id]);

    res.status(200).send("Folder and its contents deleted successfully");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting folder");
  }
});

// Patch request to rename a file
app.patch("/api/files/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    // Update the file name in the database
    const result = await pool.query(
      "UPDATE files SET name = $1, last_modified = $2 WHERE id = $3 RETURNING *",
      [name, new Date(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("File not found");
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error renaming file");
  }
});

// Patch request to rename a folder
app.patch("/api/folders/:id", async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  try {
    // Update the folder name in the database
    const result = await pool.query(
      "UPDATE folders SET name = $1, last_modified = $2 WHERE id = $3 RETURNING *",
      [name, new Date(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Folder not found");
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error renaming folder");
  }
});

// Function to get file details from the database
const getFileFromDatabase = async (fileId) => {
  try {
    const result = await pool.query("SELECT * FROM files WHERE id = $1", [
      fileId,
    ]);
    return result.rows[0]; // Return the file if found
  } catch (error) {
    console.error("Error retrieving file from the database:", error);
    throw error;
  }
};

// Route to download a file directly
app.get("/api/files/:id/download", async (req, res) => {
  try {
    const fileId = req.params.id;

    // Retrieve file information from the database
    const file = await getFileFromDatabase(fileId);
    if (!file) {
      return res.status(404).send("File not found");
    }

    // Get the file from GCS
    const gcsFile = bucket.file(file.url.split(`${bucket.name}/`)[1]);

    // Set appropriate headers for the file download
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Type", file.file_type || "application/octet-stream");

    // Create a read stream from the GCS file and pipe it directly to the response
    const stream = gcsFile.createReadStream();
    stream.on("error", (err) => {
      console.error("Error reading file from GCS:", err);
      res.status(500).send("Error downloading file");
    });

    stream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error generating download link");
  }
});

// Route to download a folder (zipped)
app.get("/api/folders/:id/download", async (req, res) => {
  const { id } = req.params;

  try {
    const folderResult = await pool.query(
      "SELECT * FROM folders WHERE id = $1",
      [id]
    );
    const folder = folderResult.rows[0];

    if (!folder) {
      return res.status(404).send("Folder not found");
    }

    // Retrieve the folder's files
    const filesResult = await pool.query(
      "SELECT * FROM files WHERE folder_id = $1",
      [id]
    );
    const files = filesResult.rows;

    if (files.length === 0) {
      return res.status(404).send("No files in this folder to download");
    }

    // Use archiver to create a zip archive
    const archiver = require("archiver");
    const archive = archiver("zip", { zlib: { level: 9 } });

    // Set the response headers for file download
    res.attachment(`${folder.name}.zip`);

    // Pipe the archive stream to the response
    archive.pipe(res);

    // Append each file from GCS to the archive
    for (const file of files) {
      const gcsFile = bucket.file(file.url.split(`${bucket.name}/`)[1]);
      const stream = gcsFile.createReadStream();

      // Handle errors when reading files
      stream.on("error", (error) => {
        console.error(`Error reading file ${file.name} from GCS:`, error);
        archive.emit("error", new Error(`Error reading file: ${file.name}`));
      });

      archive.append(stream, { name: file.name });
    }

    // Finalize the archive once all files are added
    archive.finalize();

    // Handle archiver errors
    archive.on("error", (err) => {
      console.error("Archiver error:", err);
      res.status(500).send("Error creating zip archive");
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error downloading folder");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
