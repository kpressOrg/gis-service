const express = require("express")
const dotenv = require("dotenv")
const pgp = require("pg-promise")()
const amqp = require("amqplib/callback_api")
const { v4: uuidv4 } = require("uuid")
const app = express()

dotenv.config()

const connectToDatabase = async (retries = 5, delay = 5000) => {
  while (retries) {
    try {
      const db = pgp(process.env.DATABASE_URL)
      await db.connect()
      console.log("Connected to the database")

      // Create the templates table if it doesn't exist
      await db.none(`
       CREATE TABLE IF NOT EXISTS templates (
          id UUID PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          deleted_at TIMESTAMP
        );
        `)
      console.log("Table 'templates' created successfully")

      return db
    } catch (error) {
      console.error("Failed to connect to the database, retrying...", error)
      retries -= 1
      await new Promise((res) => setTimeout(res, delay))
    }
  }
  throw new Error("Could not connect to the database after multiple attempts")
}

const connectToRabbitMQ = () => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("RabbitMQ connection timeout"))
    }, 5000) // 5 seconds timeout

    amqp.connect(process.env.RABBITMQ_URL, (error0, connection) => {
      clearTimeout(timeout)
      if (error0) {
        reject(error0)
      } else {
        resolve(connection)
      }
    })
  })
}

connectToDatabase()
  .then((db) => {
    app.use(express.json())

    app.get("/", (req, res) => {
      res.json("template service")
    })

    connectToRabbitMQ()
      .then((connection) => {
        connection.createChannel((error1, channel) => {
          if (error1) {
            throw error1
          }
          const queue = "template_created"

          channel.assertQueue(queue, {
            durable: false,
          })

          // Create a new template
          app.post("/create", (req, res) => {
            const { title, user_id } = req.body
            if (!title || !user_id) {
              return res.status(400).json({ error: "Title and user_id are required" })
            }
            const id = uuidv4()
            db.none("INSERT INTO templates(id, title, user_id) VALUES($1, $2, $3, $4)", [id, title, user_id])
              .then(() => {
                res.status(201).json({ message: "Template created successfully" })

                // Send message to RabbitMQ
                const template = { id, title, user_id }
                channel.sendToQueue(queue, Buffer.from(JSON.stringify(template)))
                console.log(" [x] Sent %s", template)
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          // Read all templates
          app.get("/all", (req, res) => {
            db.any("SELECT * FROM templates WHERE deleted_at IS NULL")
              .then((data) => {
                res.status(200).json(data)
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          // Update a template
          app.patch("/template/:id", (req, res) => {
            const { id } = req.params
            const { title, user_id } = req.body

            db.none("UPDATE templates SET title=$1, user_id=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3", [
              title,
              user_id,
              id,
            ])
              .then(() => {
                res.status(200).json({ message: "Template updated successfully" })
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          // Delete a template
          app.delete("/template/:id", (req, res) => {
            const { id } = req.params
            db.none("UPDATE templates SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1", [id])
              .then(() => {
                res.status(204).json({ message: "Template deleted successfully" })
              })
              .catch((error) => {
                res.status(500).json({ error: error.message })
              })
          })

          app.listen(process.env.PORT, () => {
            console.log(`Example app listening at ${process.env.APP_URL}:${process.env.PORT}`)
          })
        })
      })
      .catch((error) => {
        console.error("Failed to connect to RabbitMQ:", error)
      })
  })
  .catch((error) => {
    console.error("Failed to start the server:", error)
  })