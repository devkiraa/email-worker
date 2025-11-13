# Email Worker Service - Standalone Email Sender

## Overview

This is a **standalone email worker service** that runs separately from your main application. It polls MongoDB for pending email jobs and sends them using Gmail SMTP.

## Why Use This?

- **Render blocks Gmail SMTP ports** (both 587 and 465)
- **Koyeb/Railway/Fly.io** may allow SMTP connections
- **Separation of concerns**: Email sending doesn't block main app
- **Retry mechanism**: Failed emails automatically retry
- **Scalable**: Can run multiple workers

## Architecture

```
Main App (Render)
  ↓ Creates jobs in MongoDB
MongoDB (Shared database)
  ↓ Worker polls for jobs
Email Worker (Koyeb/Railway)
  ↓ Sends emails via Gmail SMTP
Gmail SMTP (Port 465/587)
```

## Setup on Koyeb

### 1. Prepare Files

```bash
cd email-worker
npm install
```

### 2. Create `.env` file

```env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/ticketdb
PORT=3001
POLL_INTERVAL=5000
NODE_ENV=production
```

### 3. Deploy to Koyeb

#### Option A: Using Dockerfile (Recommended)

1. Push to GitHub (email-worker folder)
2. Go to Koyeb Dashboard → Create Service
3. Select "Docker" as deployment method
4. Connect GitHub repository
5. Set Docker context path: `/email-worker`
6. Add environment variables from `.env`
7. Deploy!

#### Option B: Using Docker Hub

```bash
# Build and push to Docker Hub
docker build -t yourusername/email-worker:latest .
docker push yourusername/email-worker:latest

# Deploy on Koyeb
# Use Docker Hub image: yourusername/email-worker:latest
```

### 4. Configure Environment Variables

In Koyeb dashboard, add:

- `MONGODB_URI` - Your MongoDB connection string
- `PORT` - `3001` (or any port)
- `POLL_INTERVAL` - `5000` (5 seconds)
- `NODE_ENV` - `production`

### 5. Verify Deployment

Check logs for:

```
✅ MongoDB connected
🚀 Email worker service running on port 3001
🔄 Starting job polling (interval: 5000ms)
```

## How It Works

### Job Flow

1. **Main app** creates ticket → saves to DB → creates `send_email` job
2. **Email worker** polls MongoDB every 5 seconds
3. **Worker** finds pending jobs → sends emails → updates job status
4. **Retry logic**: Failed jobs retry up to 3 times

### Job Schema

```javascript
{
  ticket_id: ObjectId,
  job_type: 'send_email',
  status: 'pending', // or 'processing', 'completed', 'failed'
  priority: 0,
  data: {
    subject: 'Your Ticket',
    textBody: '...',
    htmlBody: '...',
    fromName: 'Admin'
  },
  attempts: 0,
  max_attempts: 3
}
```

## Endpoints

### Health Check

```bash
GET /health
Response: { status: 'healthy', service: 'email-worker', uptime: 12345 }
```

### Manual Trigger (Testing)

```bash
POST /trigger
Response: { success: true, message: 'Job polling triggered' }
```

### Stats

```bash
GET /stats
Response: {
  pending: 5,
  processing: 2,
  completed: 150,
  failed: 3
}
```

## Main App Changes

Update your main app's `jobProcessor.js` to create jobs instead of sending emails directly:

```javascript
// OLD: Send email immediately
await emailService.sendEmailWithAttachment({ ... });

// NEW: Create job for worker
const job = new Job({
  ticket_id: ticket._id,
  job_type: 'send_email',
  status: 'pending',
  data: {
    subject: emailSubject,
    textBody: emailBody,
    htmlBody: emailBodyHtml,
    fromName: 'Admin'
  }
});
await job.save();
logger.info('📧 Email job created, worker will process it');
```

## Port Fallback

The worker automatically tries:

1. **Port 587** (STARTTLS) first
2. **Port 465** (SSL/TLS) if 587 times out

## Monitoring

### Check Worker Logs

```bash
# Koyeb Dashboard → Your Service → Logs
```

Look for:

- `📬 Found X pending email jobs` - Worker is polling
- `✅ Email sent in Xms` - Emails sending successfully
- `⚠️ Port 587 timeout, trying port 465` - Fallback working
- `❌ Max attempts reached` - Permanent failures

### Check Job Stats

```bash
curl https://your-worker.koyeb.app/stats
```

## Troubleshooting

### Worker not processing jobs

1. Check MongoDB connection: `GET /health`
2. Verify `MONGODB_URI` is correct
3. Check main app is creating jobs (check MongoDB)

### Emails still timing out

1. Try different provider (Railway, Fly.io)
2. Use SendGrid/Mailgun API instead
3. Check Gmail App Password is correct

### Jobs stuck in "processing"

- Worker crashed during send
- Reset jobs: Update MongoDB `{ status: 'processing' }` → `{ status: 'pending' }`

## Alternative: Use Email API

If SMTP still doesn't work, switch to email API:

### SendGrid

```javascript
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
await sgMail.send(emailOptions);
```

### Mailgun

```javascript
const mailgun = require("mailgun-js");
const mg = mailgun({ apiKey: API_KEY, domain: DOMAIN });
await mg.messages().send(emailOptions);
```

### Resend

```javascript
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send(emailOptions);
```

## Scaling

### Multiple Workers

Deploy 2-3 worker instances for redundancy:

- Each polls independently
- MongoDB ensures no duplicate processing
- Load balances automatically

### Priority Queue

Set `priority` field:

```javascript
// High priority (VIP tickets)
job.priority = 10;

// Normal priority
job.priority = 0;

// Low priority (reminders)
job.priority = -10;
```

## Cost Comparison

| Provider | Free Tier            | SMTP Works? |
| -------- | -------------------- | ----------- |
| Koyeb    | 512MB RAM, 1 service | ✅ Usually  |
| Railway  | $5/month free credit | ✅ Usually  |
| Fly.io   | 3 small VMs free     | ✅ Usually  |
| Render   | Limited              | ❌ Blocked  |

## Best Practices

1. **Use App Password**: Not regular Gmail password
2. **Monitor daily limits**: Gmail has 500 emails/day limit
3. **Set poll interval**: 5-10 seconds is good balance
4. **Log everything**: Makes debugging easier
5. **Health checks**: Monitor worker status
6. **Graceful shutdown**: Handle SIGTERM properly

## Support

If you need help:

1. Check worker logs first
2. Test with `POST /trigger` endpoint
3. Verify MongoDB connection
4. Check Gmail SMTP settings

---

**Pro Tip**: Start with Koyeb (easiest), then try Railway if needed. Both have better SMTP support than Render.
