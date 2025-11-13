# Email Worker Architecture Guide

## 📧 What is the Email Worker?

The **Email Worker** is a standalone microservice deployed on **Koyeb** that handles all email sending operations for the ticket generation system. It runs independently from the main application (on Render) and communicates through MongoDB as a message queue.

## 🎯 Why Do We Need an Email Worker?

### Problem: Render Blocks Gmail SMTP

- **Render.com blocks SMTP ports** (both 587 and 465)
- Direct email sending from Render **times out**
- Tickets generate successfully but **emails never arrive**

### Solution: Separate Email Service

- Deploy email worker on **Koyeb** (SMTP ports work there)
- Main app creates "email jobs" in MongoDB
- Worker polls MongoDB every 5 seconds
- Worker sends emails via Gmail SMTP
- **Result**: Emails delivered successfully! ✅

## 🏗️ Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Google Form   │────▶│  Render Main App │────▶│    MongoDB      │
│   Submission    │     │  (Port 10000)    │     │  (Job Queue)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                                                           │ Polls every 5s
                                                           ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │   User's Email   │◀────│  Koyeb Worker   │
                        │  (Gmail inbox)   │     │  (Port 3001)    │
                        └──────────────────┘     └─────────────────┘
                                                           │
                                                           │ SMTP: 465/587
                                                           ▼
                                                  ┌─────────────────┐
                                                  │  Gmail SMTP     │
                                                  │  smtp.gmail.com │
                                                  └─────────────────┘
```

## 📦 What Data is Sent to the Email Worker?

### Main App Creates Job Document in MongoDB

When a ticket is generated, the main app creates an **email job** with this structure:

```javascript
{
  _id: ObjectId("6915ee56d305d433279da1ff"),

  // Job Type & Status
  job_type: "send_email",               // Type of job (send_email, generate_ticket, etc.)
  status: "pending",                     // pending → processing → completed/failed

  // Email Data
  data: {
    // Ticket Information
    ticketId: "6915ee4ed305d433279da1f2",        // MongoDB ObjectId of ticket

    // Email Content
    subject: "Your Ticket for Bios Meetup 2025",  // Email subject line
    textBody: "Dear Kiran S,\n\nYour ticket...",  // Plain text email body
    htmlBody: "<html>...</html>",                 // HTML email body (optional)
    fromName: "Admin",                            // Sender name

    // Recipient Information
    recipientEmail: "devkiraa@gmail.com",         // Where to send
    recipientName: "Kiran S",                     // Recipient's name

    // Attachment (Base64 Encoded)
    attachmentBase64: "iVBORw0KGgoAAAANSUhEUgAA...",  // Ticket image as base64
    attachmentFilename: "Bios_Meetup_2025_FXJIS4Z2.png"  // Filename for attachment
  },

  // Retry Management
  retries: 0,                           // Current attempt count
  maxRetries: 3,                        // Maximum retry attempts
  nextRetryAt: null,                    // When to retry if failed

  // Error Tracking
  error: null,                          // Error message if failed
  result: null,                         // Success result after completion

  // Timestamps
  created_at: ISODate("2025-11-13T14:42:30.000Z"),
  updated_at: ISODate("2025-11-13T14:42:30.000Z")
}
```

### Why Base64 for Attachments?

**Problem**: Worker on Koyeb can't access Render's filesystem
**Solution**: Encode image as base64 string and store in MongoDB

```javascript
// Main App (Render)
const attachmentBuffer = await fs.readFile(
  "/opt/render/project/src/QR_GENERATED/ticket.png"
);
const attachmentBase64 = attachmentBuffer.toString("base64");

// Store in job data
job.data.attachmentBase64 = attachmentBase64; // ~45KB for typical ticket

// Worker (Koyeb)
const buffer = Buffer.from(job.data.attachmentBase64, "base64");
// Now worker has the image without file access!
```

## 🔄 Email Worker Workflow

### Step-by-Step Process

```
1. POLLING (Every 5 seconds)
   ├─ Worker queries MongoDB:
   │  Query: { job_type: "send_email", status: "pending", retries: { $lt: 3 } }
   └─ Finds: 1 pending job

2. JOB PROCESSING
   ├─ Update status: pending → processing
   ├─ Increment retries: 0 → 1
   ├─ Fetch ticket from MongoDB
   └─ Get active email credential (sicasaskochi@gmail.com)

3. EMAIL PREPARATION
   ├─ Decode base64 attachment → Buffer
   ├─ Create nodemailer transporter
   │  ├─ Host: smtp.gmail.com
   │  ├─ Port: 465 (SSL) or 587 (STARTTLS)
   │  └─ Auth: App Password
   └─ Prepare email options:
      ├─ From: "Admin <sicasaskochi@gmail.com>"
      ├─ To: "devkiraa@gmail.com"
      ├─ Subject: "Your Ticket for Bios Meetup 2025"
      ├─ Text/HTML body
      └─ Attachment: Bios_Meetup_2025_FXJIS4Z2.png

4. SMTP SENDING
   ├─ Try port 587 first (STARTTLS)
   │  ├─ Success → Send email
   │  └─ Timeout → Fallback to port 465
   └─ Port 465 (SSL/TLS) → Send email

5. UPDATE JOB STATUS
   ├─ If SUCCESS:
   │  ├─ status: processing → completed
   │  ├─ result: { success: true, messageId: "..." }
   │  └─ Ticket status: generated → sent
   └─ If FAILED:
      ├─ status: processing → pending (retry)
      ├─ error: "SMTP timeout" or other error
      └─ If retries >= 3: status → failed
```

### Worker Polling Loop

```javascript
// Runs every 5 seconds
setInterval(async () => {
  // 1. Query for pending jobs
  const jobs = await Job.find({
    job_type: "send_email",
    status: "pending",
    retries: { $lt: 3 },
  })
    .sort({ created_at: 1 })
    .limit(5);

  // 2. Process each job
  for (const job of jobs) {
    await processEmailJob(job);
  }
}, 5000);
```

## 📊 Data Flow Example

### Complete Flow with Actual Data

```javascript
// 1. USER SUBMITS FORM
POST https://forms.google.com/...
{
  "Full Name": "Kiran S",
  "Email Address": "devkiraa@gmail.com",
  "Phone Number": "9446565036",
  "Event Selection": "Workshop on AI"
}

// 2. MAIN APP RECEIVES WEBHOOK
POST /api/public/register
├─ Create ticket: FXJIS4Z2
├─ Generate QR code image
└─ Create ticket generation job

// 3. JOB PROCESSOR GENERATES TICKET
├─ Generate ticket image: Bios_Meetup_2025_FXJIS4Z2.png
├─ Save to: /opt/render/project/src/QR_GENERATED/
├─ Read file → Convert to base64 (45 KB)
└─ Create email job:

{
  job_type: "send_email",
  status: "pending",
  data: {
    ticketId: "6915ee4ed305d433279da1f2",
    subject: "Your Ticket for Bios Meetup 2025",
    textBody: "Dear Kiran S,\n\nThank you for registering...",
    recipientEmail: "devkiraa@gmail.com",
    recipientName: "Kiran S",
    attachmentBase64: "iVBORw0KGgoAAAANSUhEUgAAB9AAAAQ4CAY...",
    attachmentFilename: "Bios_Meetup_2025_FXJIS4Z2.png"
  },
  retries: 0,
  maxRetries: 3
}

// 4. WORKER POLLS MONGODB (5 seconds later)
Query: { job_type: "send_email", status: "pending" }
Result: Found 1 job → 6915ee56d305d433279da1ff

// 5. WORKER PROCESSES JOB
├─ Decode base64 → Buffer (45 KB)
├─ Get credential: sicasaskochi@gmail.com
├─ Create SMTP transporter (port 465)
├─ Send email with attachment
└─ Update job status: completed

// 6. USER RECEIVES EMAIL
Gmail inbox: devkiraa@gmail.com
Subject: "Your Ticket for Bios Meetup 2025"
Attachment: Bios_Meetup_2025_FXJIS4Z2.png (45 KB)
```

## 🔧 Worker Configuration

### Environment Variables (Koyeb)

```env
# MongoDB Connection
MONGODB_URI=mongodb+srv://isitreal126:fHkNZJ8SeAk12Z8U@cluster0.lrxvx.mongodb.net/tkc

# Worker Settings
PORT=3001
POLL_INTERVAL=5000          # Poll every 5 seconds (5000ms)
NODE_ENV=production
```

### Main App Environment Variables (Render)

```env
# Email Worker URL (for health checks/stats)
EMAIL_WORKER_URL=https://responsible-raquela-startupsprint-01-de9d46ec.koyeb.app
EMAIL_WORKER_ENABLED=true

# MongoDB Connection (same as worker)
MONGODB_URI=mongodb+srv://isitreal126:fHkNZJ8SeAk12Z8U@cluster0.lrxvx.mongodb.net/tkc
```

## 📈 Email Credential Management

### Credentials Stored in MongoDB

```javascript
{
  _id: ObjectId("..."),
  name: "Primary Gmail",
  email: "sicasaskochi@gmail.com",
  smtp_server: "smtp.gmail.com",
  smtp_port: 465,                    // or 587 for STARTTLS
  username: "sicasaskochi@gmail.com",
  password: "xxxx xxxx xxxx xxxx",   // Gmail App Password (16 chars)
  is_active: true,                   // Enable/disable credential
  daily_limit: 500,                  // Max emails per day
  daily_usage: 0,                    // Incremented after each send
  created_at: ISODate("..."),
  updated_at: ISODate("...")
}
```

### Worker Credential Selection

```javascript
// Worker picks first available credential
const credential = await EmailCredential.findOne({
  is_active: true,
  $or: [
    { daily_limit: { $exists: false } }, // No limit set
    { daily_limit: null }, // No limit
    { $expr: { $lt: ["$daily_usage", "$daily_limit"] } }, // Under limit
  ],
});

// After successful send, increment usage
await EmailCredential.findByIdAndUpdate(credential._id, {
  $inc: { daily_usage: 1 },
});
```

## 🚨 Error Handling & Retry Logic

### Retry Mechanism

```javascript
// Attempt 1 (retries: 0)
├─ Try sending...
└─ SMTP Timeout → status: pending, retries: 1

// Attempt 2 (retries: 1) - 5 seconds later
├─ Try sending...
└─ Connection Error → status: pending, retries: 2

// Attempt 3 (retries: 2) - 5 seconds later
├─ Try sending...
└─ Success! → status: completed

// If Attempt 3 fails (retries: 3)
└─ retries >= maxRetries → status: failed (permanent failure)
```

### Port Fallback Strategy

```javascript
try {
  // Try port 587 first (STARTTLS)
  await sendEmail(credential, emailOptions, (usePort465 = false));
} catch (error) {
  if (error.code === "ETIMEDOUT" && credential.smtp_port === 587) {
    // Fallback to port 465 (SSL/TLS)
    logger.warn("⚠️ Port 587 timeout, trying port 465...");
    await sendEmail(credential, emailOptions, (usePort465 = true));
  } else {
    throw error; // Other errors, don't retry
  }
}
```

## 📊 Monitoring & Health Checks

### Worker Endpoints

```bash
# Health Check
GET https://responsible-raquela-startupsprint-01-de9d46ec.koyeb.app/health
Response:
{
  "status": "healthy",
  "mongodb": "connected",
  "uptime": "3600 seconds",
  "lastPoll": "2025-11-13T14:42:52.679Z"
}

# Worker Stats
GET https://responsible-raquela-startupsprint-01-de9d46ec.koyeb.app/stats
Response:
{
  "totalJobs": 125,
  "pendingJobs": 0,
  "processingJobs": 0,
  "completedJobs": 120,
  "failedJobs": 5,
  "mongodb": "connected"
}

# Manual Trigger (testing only)
POST https://responsible-raquela-startupsprint-01-de9d46ec.koyeb.app/trigger
Response:
{
  "message": "Polling triggered manually",
  "jobsFound": 1,
  "jobsProcessed": 1
}
```

### Koyeb Logs

```
[INFO] 2025-11-13T14:42:47.678Z - 🔍 Polling for pending email jobs...
[INFO] 2025-11-13T14:42:47.765Z - 📬 Found 1 pending email jobs
[INFO] 2025-11-13T14:42:47.766Z - 📧 Processing email job 6915ee56... (Attempt 1/3)
[INFO] 2025-11-13T14:42:47.850Z - 🎫 Ticket: FXJIS4Z2 for Kiran S
[INFO] 2025-11-13T14:42:47.900Z - 📧 Using credential: sicasaskochi@gmail.com (0/500)
[INFO] 2025-11-13T14:42:47.901Z - 📎 Attachment loaded: Bios_Meetup_2025_FXJIS4Z2.png (45.23 KB)
[INFO] 2025-11-13T14:42:47.902Z - 📧 Creating transporter: smtp.gmail.com:465 (secure: true)
[INFO] 2025-11-13T14:42:48.100Z - ✅ SMTP verified in 198ms
[INFO] 2025-11-13T14:42:48.834Z - ✅ Email sent in 734ms - Message ID: <abc123@gmail.com>
[INFO] 2025-11-13T14:42:48.900Z - ✅ Email job 6915ee56... completed successfully
```

## 🎯 Benefits of This Architecture

### 1. **Separation of Concerns**

- Main app focuses on ticket generation
- Worker focuses on email delivery
- Each service can scale independently

### 2. **Reliability**

- If email fails, job stays pending
- Automatic retry with exponential backoff
- Jobs persist in MongoDB (survives crashes)

### 3. **Flexibility**

- Easy to add more workers for load balancing
- Can switch email providers without touching main app
- Queue prioritization possible

### 4. **Monitoring**

- Clear visibility into email queue
- Track success/failure rates
- Alert on failed jobs

### 5. **Cost Optimization**

- Worker only runs when needed
- Main app doesn't wait for SMTP
- Can use cheaper hosting for worker

## 🔐 Security Considerations

### 1. **Gmail App Passwords**

- Never use real Gmail password
- Use 16-character App Passwords
- Rotate passwords regularly

### 2. **MongoDB Access**

- Use connection string with credentials
- Restrict IP addresses if possible
- Enable MongoDB authentication

### 3. **Environment Variables**

- Never commit `.env` files
- Use Koyeb/Render secrets management
- Rotate credentials periodically

### 4. **Data Privacy**

- Base64 attachments stored temporarily
- Jobs cleaned up after completion
- Minimal PII in logs

## 📝 Summary

### What is Sent to Email Worker?

The main app **doesn't directly send anything** to the worker. Instead:

1. **Main app writes to MongoDB** → Email job document
2. **Worker polls MongoDB** → Reads job document
3. **Worker sends email** → Via Gmail SMTP
4. **Worker updates MongoDB** → Job status

### Data Included in Email Job:

- ✅ Ticket ID (to fetch ticket details)
- ✅ Email subject & body (plain text or HTML)
- ✅ Recipient email & name
- ✅ Sender name
- ✅ **Attachment as base64** (ticket image, ~45 KB)
- ✅ Attachment filename
- ✅ Retry count & max retries

### Email Worker Purpose:

1. **Bypass Render's SMTP blocking** (main reason!)
2. **Asynchronous email sending** (don't block ticket generation)
3. **Automatic retries** (handle transient failures)
4. **Centralized email management** (one place for all email logic)
5. **Scalability** (add more workers if needed)

---

**Architecture Type**: Message Queue Pattern (MongoDB as queue)
**Communication**: Indirect (via MongoDB, no direct HTTP calls)
**Deployment**: Main App (Render) + Worker (Koyeb) + Database (MongoDB Atlas)
