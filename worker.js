// Email Worker Service - Polls MongoDB for pending email jobs and sends them
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3001;
const POLL_INTERVAL = process.env.POLL_INTERVAL || 5000; // 5 seconds

// Job Schema
const jobSchema = new mongoose.Schema({
  ticket_id: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket" },
  job_type: {
    type: String,
    enum: ["generate_ticket", "send_email"],
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
  },
  priority: { type: Number, default: 0 },
  data: mongoose.Schema.Types.Mixed,
  error: String,
  attempts: { type: Number, default: 0 },
  max_attempts: { type: Number, default: 3 },
  created_at: { type: Date, default: Date.now },
  processed_at: Date,
});

const Job = mongoose.model("Job", jobSchema);

// Ticket Schema (minimal for reference)
const ticketSchema = new mongoose.Schema({
  ticket_number: String,
  event_id: { type: mongoose.Schema.Types.ObjectId, ref: "Event" },
  attendee_name: String,
  attendee_email: String,
  attendee_phone: String,
  image_url: String,
  status: String,
});

const Ticket = mongoose.model("Ticket", ticketSchema);

// Email Credential Schema
const emailCredentialSchema = new mongoose.Schema({
  name: String,
  email: String,
  smtp_server: String,
  smtp_port: Number,
  username: String,
  password: String,
  is_active: { type: Boolean, default: true },
  daily_limit: Number,
  daily_usage: { type: Number, default: 0 },
});

const EmailCredential = mongoose.model(
  "EmailCredential",
  emailCredentialSchema
);

// Logger
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`),
};

// Email Service with port fallback
async function sendEmail(credential, emailOptions, usePort465 = false) {
  const port = usePort465 ? 465 : credential.smtp_port;
  const secure = port === 465;

  logger.info(
    `📧 Creating transporter: ${credential.smtp_server}:${port} (secure: ${secure})`
  );

  const transporter = nodemailer.createTransport({
    host: credential.smtp_server,
    port: port,
    secure: secure,
    auth: {
      user: credential.username,
      pass: credential.password,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 5,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
  });

  // Verify connection
  logger.info(`🔍 Verifying SMTP connection...`);
  const verifyStart = Date.now();
  await transporter.verify();
  logger.info(`✅ SMTP verified in ${Date.now() - verifyStart}ms`);

  // Send email
  logger.info(`📨 Sending email to ${emailOptions.to}...`);
  const sendStart = Date.now();
  const info = await transporter.sendMail(emailOptions);
  logger.info(
    `✅ Email sent in ${Date.now() - sendStart}ms - Message ID: ${
      info.messageId
    }`
  );

  transporter.close();
  return info;
}

// Process email job with retry logic
async function processEmailJob(job) {
  try {
    logger.info(
      `📧 Processing email job ${job._id} (Attempt ${job.attempts + 1}/${
        job.max_attempts
      })`
    );

    // Update job status
    job.status = "processing";
    job.attempts += 1;
    await job.save();

    // Get ticket details
    const ticket = await Ticket.findById(job.ticket_id).populate("event_id");
    if (!ticket) {
      throw new Error("Ticket not found");
    }

    logger.info(
      `🎫 Ticket: ${ticket.ticket_number} for ${ticket.attendee_name}`
    );

    // Get email credential
    const credential = await EmailCredential.findOne({
      is_active: true,
      $or: [
        { daily_limit: { $exists: false } },
        { daily_limit: null },
        { $expr: { $lt: ["$daily_usage", "$daily_limit"] } },
      ],
    });

    if (!credential) {
      throw new Error("No available email credentials");
    }

    logger.info(
      `📧 Using credential: ${credential.email} (${
        credential.daily_usage || 0
      }/${credential.daily_limit || "unlimited"})`
    );

    // Prepare email options
    const attachmentPath = path.join(
      __dirname,
      "..",
      "QR_GENERATED",
      path.basename(ticket.image_url || "")
    );

    // Check if attachment exists
    if (!fs.existsSync(attachmentPath)) {
      throw new Error(`Attachment not found: ${attachmentPath}`);
    }

    const emailOptions = {
      from: `"${job.data.fromName || "Admin"}" <${credential.email}>`,
      to: ticket.attendee_email,
      subject: job.data.subject || `Your Ticket for ${ticket.event_id?.name}`,
      text: job.data.textBody || `Your ticket is attached.`,
      html: job.data.htmlBody || null,
      attachments: [
        {
          filename: path.basename(ticket.image_url),
          path: attachmentPath,
        },
      ],
    };

    // Try sending with configured port first
    let emailInfo;
    try {
      emailInfo = await sendEmail(credential, emailOptions, false);
    } catch (error) {
      if (error.code === "ETIMEDOUT" && credential.smtp_port === 587) {
        logger.warn(`⚠️ Port 587 timeout, trying port 465...`);
        emailInfo = await sendEmail(credential, emailOptions, true);
      } else {
        throw error;
      }
    }

    // Update credential usage
    await EmailCredential.findByIdAndUpdate(credential._id, {
      $inc: { daily_usage: 1 },
    });

    // Mark job as completed
    job.status = "completed";
    job.processed_at = new Date();
    await job.save();

    // Update ticket status
    ticket.status = "sent";
    await ticket.save();

    logger.info(`✅ Email job ${job._id} completed successfully`);
    return true;
  } catch (error) {
    logger.error(`❌ Email job ${job._id} failed: ${error.message}`);

    // Update job with error
    job.error = error.message;

    if (job.attempts >= job.max_attempts) {
      job.status = "failed";
      logger.error(`❌ Max attempts reached for job ${job._id}`);
    } else {
      job.status = "pending"; // Retry later
      logger.info(`🔄 Job ${job._id} will be retried`);
    }

    await job.save();
    return false;
  }
}

// Poll for pending jobs
async function pollJobs() {
  try {
    // Find pending email jobs
    const jobs = await Job.find({
      job_type: "send_email",
      status: "pending",
      attempts: { $lt: mongoose.mongo.MAX_ATTEMPTS || 3 },
    })
      .sort({ priority: -1, created_at: 1 })
      .limit(5); // Process 5 jobs at a time

    if (jobs.length > 0) {
      logger.info(`📬 Found ${jobs.length} pending email jobs`);

      for (const job of jobs) {
        await processEmailJob(job);
        // Small delay between jobs
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    logger.error(`❌ Polling error: ${error.message}`);
  }
}

// Root endpoint with service details
app.get("/", (req, res) => {
  const mongoStatus =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  const mongoStates = [
    "disconnected",
    "connected",
    "connecting",
    "disconnecting",
  ];

  res.json({
    service: "Email Worker Service",
    version: "1.0.0",
    description: "Standalone email worker for ticket generation system",
    status: mongoStatus === "connected" ? "healthy" : "unhealthy",
    uptime: `${Math.floor(process.uptime())} seconds`,
    environment: process.env.NODE_ENV || "development",
    mongodb: {
      status: mongoStatus,
      state: mongoStates[mongoose.connection.readyState],
      database: mongoose.connection.name || "unknown",
    },
    configuration: {
      port: PORT,
      poll_interval: `${POLL_INTERVAL}ms`,
    },
    endpoints: {
      health: "/health",
      stats: "/stats",
      trigger: "POST /trigger",
    },
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  const status = mongoose.connection.readyState === 1 ? "healthy" : "unhealthy";
  res.json({
    status,
    service: "email-worker",
    uptime: process.uptime(),
    mongodb:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// Manual trigger endpoint (for testing)
app.post("/trigger", async (req, res) => {
  try {
    await pollJobs();
    res.json({ success: true, message: "Job polling triggered" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stats endpoint
app.get("/stats", async (req, res) => {
  try {
    const stats = {
      pending: await Job.countDocuments({
        job_type: "send_email",
        status: "pending",
      }),
      processing: await Job.countDocuments({
        job_type: "send_email",
        status: "processing",
      }),
      completed: await Job.countDocuments({
        job_type: "send_email",
        status: "completed",
      }),
      failed: await Job.countDocuments({
        job_type: "send_email",
        status: "failed",
      }),
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start worker
async function startWorker() {
  try {
    // Connect to MongoDB
    logger.info(`🔌 Connecting to MongoDB...`);
    await mongoose.connect(MONGODB_URI);
    logger.info(`✅ MongoDB connected`);

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`🚀 Email worker service running on port ${PORT}`);
    });

    // Start polling
    logger.info(`🔄 Starting job polling (interval: ${POLL_INTERVAL}ms)`);
    setInterval(pollJobs, POLL_INTERVAL);

    // Initial poll
    await pollJobs();
  } catch (error) {
    logger.error(`❌ Failed to start worker: ${error.message}`);
    process.exit(1);
  }
}

// Handle shutdown
process.on("SIGTERM", async () => {
  logger.info("⏹️  SIGTERM received, shutting down gracefully...");
  await mongoose.connection.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("⏹️  SIGINT received, shutting down gracefully...");
  await mongoose.connection.close();
  process.exit(0);
});

// Start
startWorker();
