# Deploy Email Worker to Koyeb

## Prerequisites

- GitHub account
- Koyeb account (free tier)
- MongoDB connection string

## Step 1: Prepare Repository

### Push email-worker folder to GitHub

```bash
cd email-worker
git init
git add .
git commit -m "Initial email worker"
git remote add origin https://github.com/yourusername/email-worker.git
git push -u origin main
```

Or add to existing repo:

```bash
git add email-worker/
git commit -m "Add email worker service"
git push
```

## Step 2: Create Koyeb Account

1. Go to https://www.koyeb.com/
2. Click "Start for free"
3. Sign up with GitHub
4. Verify email

## Step 3: Deploy Service

### Method A: Using GitHub (Recommended)

1. **Click "Create Service"**

   - Select "GitHub"
   - Authorize Koyeb to access your repository

2. **Select Repository**

   - Choose your repository
   - Select branch: `main` or `master`

3. **Configure Build**

   - Build method: **Docker**
   - Dockerfile path: `email-worker/Dockerfile`
   - Build context: `/email-worker` (if in subdirectory)
   - Or root `/` if email-worker is at repo root

4. **Configure Instance**

   - Region: Choose closest to your MongoDB
   - Instance type: **Nano** (512MB RAM - FREE)
   - Scaling: **Fixed** → 1 instance

5. **Configure Port**

   - Port: `3001`
   - Health check path: `/health`

6. **Environment Variables**
   Click "Add environment variable" and add:

   ```
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/ticketdb
   PORT=3001
   POLL_INTERVAL=5000
   NODE_ENV=production
   ```

7. **Service Name**

   - Name: `email-worker` or any name you like
   - This will be your URL: `email-worker-yourorg.koyeb.app`

8. **Click "Deploy"**
   - Wait 3-5 minutes for build
   - Watch build logs

### Method B: Using Docker Hub

If you prefer to build locally:

```bash
cd email-worker

# Build image
docker build -t yourusername/email-worker:latest .

# Login to Docker Hub
docker login

# Push to Docker Hub
docker push yourusername/email-worker:latest
```

Then in Koyeb:

1. Select "Docker Hub"
2. Image: `yourusername/email-worker:latest`
3. Port: `3001`
4. Add environment variables (same as above)
5. Deploy

## Step 4: Verify Deployment

### Check Health

```bash
curl https://your-service.koyeb.app/health
```

Expected response:

```json
{
  "status": "healthy",
  "service": "email-worker",
  "uptime": 123.45,
  "mongodb": "connected"
}
```

### Check Stats

```bash
curl https://your-service.koyeb.app/stats
```

Expected response:

```json
{
  "pending": 0,
  "processing": 0,
  "completed": 0,
  "failed": 0
}
```

### Check Logs

In Koyeb dashboard:

1. Click on your service
2. Go to "Logs" tab
3. Look for:
   ```
   ✅ MongoDB connected
   🚀 Email worker service running on port 3001
   🔄 Starting job polling (interval: 5000ms)
   ```

## Step 5: Test Email Sending

### Submit a Google Form

The worker will:

1. Poll MongoDB every 5 seconds
2. Find pending email jobs
3. Send emails via Gmail SMTP
4. Update job status

### Check Logs for:

```
📬 Found 1 pending email jobs
📧 Processing email job 123abc...
📧 Creating transporter: smtp.gmail.com:587 (secure: false)
🔍 Verifying SMTP connection...
✅ SMTP verified in 234ms
📨 Sending email to user@example.com...
✅ Email sent in 456ms - Message ID: <abc@gmail.com>
✅ Email job 123abc completed successfully
```

### If Port 465 Fallback Happens:

```
❌ SMTP verification failed: Connection timeout
⚠️ Port 587 timeout, trying port 465...
📧 Creating transporter: smtp.gmail.com:465 (secure: true)
✅ SMTP verified in 234ms
✅ Email sent in 456ms
```

## Step 6: Monitor Usage

### Koyeb Dashboard

- Go to your service
- Check **Metrics** tab for:
  - CPU usage
  - Memory usage
  - Network traffic

### Check Job Stats Regularly

```bash
# Every minute
watch -n 60 curl https://your-service.koyeb.app/stats
```

### Set Up Alerts (Optional)

In Koyeb dashboard:

1. Go to "Settings" → "Notifications"
2. Enable email notifications for:
   - Service crashes
   - High memory usage
   - Health check failures

## Step 7: Update Main App

Your main app (on Render) doesn't need changes! The jobProcessor already creates jobs in MongoDB. The worker will pick them up automatically.

### Verify Jobs Are Created

Check MongoDB:

```javascript
db.jobs.find({ job_type: "send_email", status: "pending" });
```

Should see jobs like:

```json
{
  "_id": "...",
  "ticket_id": "...",
  "job_type": "send_email",
  "status": "pending",
  "data": {
    "subject": "Your Ticket",
    "textBody": "...",
    "htmlBody": "..."
  },
  "attempts": 0,
  "max_attempts": 3,
  "created_at": "2025-11-13T04:39:11.000Z"
}
```

## Troubleshooting

### Worker Not Starting

**Check build logs** for errors:

```
Error: Cannot find module 'nodemailer'
```

→ Run `npm install` in email-worker folder before pushing

### MongoDB Connection Failed

**Check environment variables**:

```bash
# In Koyeb dashboard → Service → Settings → Environment
MONGODB_URI should match your connection string
```

Test connection:

```bash
# From your local machine
mongo "mongodb+srv://user:pass@cluster.mongodb.net/ticketdb"
```

### Port 587 AND 465 Timeout

**Provider still blocking SMTP**

Try different provider:

1. **Railway**: Better SMTP support
2. **Fly.io**: Usually allows SMTP
3. **Digital Ocean App Platform**: Allows SMTP

Or use email API (Resend, SendGrid) - see EMAIL-SERVICE-MIGRATION.md

### Jobs Not Processing

**Check worker logs**:

```
📬 Found 0 pending email jobs
```

→ Main app not creating jobs. Check main app logs.

**Worker crashed**:

```
Service unavailable
```

→ Check Koyeb logs for errors (OOM, crash)

### Emails Still Not Sending

**Gmail App Password**:

1. Go to https://myaccount.google.com/apppasswords
2. Enable 2FA
3. Generate App Password
4. Update email credential in database with App Password

**Daily Limit Reached**:

```
❌ No available email credentials
```

→ Gmail has 500 emails/day limit. Wait until tomorrow or add another credential.

## Alternative Providers

If Koyeb doesn't work, try:

### Railway

1. Similar to Koyeb
2. $5/month free credit
3. Better SMTP support
4. Deploy: https://railway.app/

### Fly.io

1. 3 VMs free
2. Usually allows SMTP
3. More complex setup
4. Deploy: https://fly.io/

### Render (Worker Service)

1. Wait, Render blocks SMTP! 😅
2. But you can deploy worker on Render Web Service
3. Then worker connects to external SMTP proxy
4. Or use email API instead

## Cost Breakdown

### Free Tier (Koyeb)

- ✅ 1 web service (512MB RAM)
- ✅ Unlimited builds
- ✅ 100GB bandwidth/month
- ✅ Free SSL certificate
- ✅ Perfect for email worker!

### Paid Plans (if needed)

- **Hobby**: $5.50/month (1GB RAM)
- **Pro**: $18/month (2GB RAM)

**For 99% of cases, FREE tier is enough!**

## Monitoring Best Practices

### 1. Daily Health Checks

```bash
# Add to cron
0 9 * * * curl https://your-worker.koyeb.app/health | mail -s "Worker Health" you@email.com
```

### 2. Monitor Failed Jobs

```javascript
// Add alert when failed jobs > 10
db.jobs.countDocuments({ status: "failed" }).then((count) => {
  if (count > 10) {
    // Send alert
  }
});
```

### 3. Check Daily Usage

```javascript
// Monitor email credential usage
db.emailcredentials.find({ daily_usage: { $gt: 400 } });
// Alert if approaching 500 limit
```

## Scaling

### Multiple Workers

Deploy 2-3 instances:

- Each polls independently
- MongoDB prevents duplicate processing
- Load balances automatically
- Better reliability

### Faster Polling

Change `POLL_INTERVAL`:

```env
POLL_INTERVAL=2000  # 2 seconds (faster)
POLL_INTERVAL=10000 # 10 seconds (slower, less resource usage)
```

### Priority Queues

Update jobs with priority:

```javascript
// VIP tickets
job.priority = 10;

// Normal tickets
job.priority = 0;

// Bulk emails
job.priority = -10;
```

Worker processes high priority first!

## Success Checklist

- ✅ Worker deployed on Koyeb
- ✅ `/health` returns "healthy"
- ✅ MongoDB connected
- ✅ Worker logs show polling
- ✅ Form submission creates job
- ✅ Worker picks up job
- ✅ Email sends successfully
- ✅ Job status = "completed"
- ✅ Ticket status = "sent"
- ✅ User receives email with attachment

---

**You're done!** 🎉

Your email worker is now running independently, processing email jobs from MongoDB, and sending tickets via Gmail SMTP (with port 465 fallback).

Need help? Check the logs first, then open an issue with:

1. Worker logs
2. Main app logs
3. MongoDB job document
4. Error message
