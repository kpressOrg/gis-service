require("dotenv").config();
const express = require("express");
const amqp = require("amqplib");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const knex = require("knex")({
  client: "pg",
  connection: process.env.DATABASE_URL,
});

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(morgan("dev"));

// Global connection variables
let rabbitMQConnection;
let rabbitMQChannel;

const connectToDatabase = async (retries = 5, delay = 5000) => {
  while (retries) {
    try {
      await knex.raw("SELECT 1");
      console.log("Connected to the database");

      const exists = await knex.schema.hasTable("areas");
      if (!exists) {
        await knex.schema.createTable("areas", (table) => {
          table.increments("id").primary();
          table.string("name");
          table.specificType("geom", "geometry(POLYGON, 4326)");
        });
        console.log("Table 'areas' created successfully");
      }

      return knex;
    } catch (error) {
      console.error("Failed to connect to the database, retrying...", error);
      retries -= 1;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw new Error("Could not connect to the database after multiple attempts");
};

const connectToRabbitMQ = async () => {
  try {
    rabbitMQConnection = await amqp.connect(process.env.RABBITMQ_URL);
    rabbitMQChannel = await rabbitMQConnection.createChannel();
    console.log("Connected to RabbitMQ");
    return { connection: rabbitMQConnection, channel: rabbitMQChannel };
  } catch (error) {
    console.error("Failed to connect to RabbitMQ:", error);
    throw error;
  }
};

// Define the path to the MBTiles file
const mbtilesPath = path.join(__dirname, "storage", "saudi.mbtiles");

app.get("/", (req, res) => {
  res.json("gis service");
});

app.get("/api/tiles/:z/:x/:y.pbf", (req, res) => {
  const { z, x, y } = req.params;
  const tileY = (1 << z) - 1 - parseInt(y, 10);

  console.log(`Fetching vector tile: z=${z}, x=${x}, y=${tileY}`);

  const db = new sqlite3.Database(mbtilesPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      console.error("Error opening MBTiles database:", err);
      return res.status(500).json({ error: "Error opening MBTiles file" });
    }

    db.get(
      `SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?`,
      [parseInt(z, 10), parseInt(x, 10), tileY],
      (err, row) => {
        db.close((closeErr) => {
          if (closeErr) {
            console.error("Error closing database:", closeErr);
          }
        });

        if (err || !row) {
          console.error(`Tile not found at z:${z}, x:${x}, y:${tileY}`, err);
          return res.status(404).json({ error: "Tile not found" });
        }

        console.log(`Vector tile retrieved: ${z}/${x}/${y}, size=${row.tile_data.length} bytes`);
        res.setHeader("Content-Type", "application/x-protobuf");
        res.setHeader("Content-Encoding", "gzip");
        res.send(row.tile_data);
      }
    );
  });
});

app.post("/api/areas", async (req, res) => {
  const { name, geojson } = req.body;
  if (!name || !geojson) {
    return res.status(400).json({ error: "Name and GeoJSON are required" });
  }

  console.log("Received GeoJSON:", JSON.stringify(geojson, null, 2));

  try {
    const result = await knex("areas")
      .insert({
        name,
        geom: knex.raw("ST_GeomFromGeoJSON(?)", [JSON.stringify(geojson.geometry)]),
      })
      .returning("*");
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/areas", async (req, res) => {
  try {
    const result = await knex("areas").select(
      "id",
      "name",
      knex.raw("ST_AsGeoJSON(geom) as geojson")
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/areas", async (req, res) => {
  try {
    await knex("areas").del();
    res.json({ message: "All AOIs removed successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware (placed after routes)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectToDatabase();
    await connectToRabbitMQ();
    const queue = "gis_created";
    rabbitMQChannel.assertQueue(queue, { durable: false });

    const server = app.listen(PORT, () => {
      console.log(`Server listening at ${process.env.APP_URL || "http://localhost"}:${PORT}`);
    });

    // Graceful shutdown on termination signals
    const gracefulShutdown = async () => {
      console.log("Shutting down server...");
      server.close();
      if (rabbitMQConnection) {
        try {
          await rabbitMQConnection.close();
        } catch (err) {
          console.error("Error closing RabbitMQ connection:", err);
        }
      }
      await knex.destroy();
      process.exit(0);
    };

    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);

  } catch (error) {
    console.error("Failed to start the server:", error);
    process.exit(1);
  }
}

startServer();
