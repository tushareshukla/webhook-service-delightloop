require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const formidable = require('formidable');
const fs = require('fs');
const { simpleParser } = require('mailparser');

const app = express();

// For Event Webhook (JSON body)
app.use('/webhooks/sendgrid-events', express.json({ type: '*/*' }));

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGO_URI, { useUnifiedTopology: true });
let db;
async function getDb() {
  if (!db) {
    await mongoClient.connect();
    db = mongoClient.db();
    console.log('[Mongo] Connected');
  }
  return db;
}

// --- SendGrid Event Webhook (raw JSON array of events) ---
app.post('/webhooks/sendgrid-events', async (req, res) => {
  const events = req.body;
  if (!Array.isArray(events)) return res.status(400).send('Payload must be array');

  try {
    const db = await getDb();
    const result = await db.collection('sendgrid_events').insertMany(events, { ordered: false });
    res.status(200).send(`Stored ${result.insertedCount} events`);
  } catch (err) {
    console.error('[ERR] Mongo insert error:', err);
    res.status(500).send('DB error');
  }
});

// --- SendGrid Inbound Parse Webhook (multipart MIME message) ---
app.post('/webhooks/inbound-email', (req, res) => {
  const form = formidable({ multiples: false });
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('[ERR] Formidable parse error:', err);
      res.status(500).send('Form parse error');
      return;
    }
    if (!files.email) {
      res.status(400).send('No email field found');
      return;
    }
    try {
      // Read and parse the raw MIME email
      const rawEmail = fs.readFileSync(files.email[0].filepath);
      const parsed = await simpleParser(rawEmail);

      const db = await getDb();
      await db.collection('inbound_emails').insertOne({
        from: parsed.from?.text,
        to: parsed.to?.text,
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        headers: parsed.headers,
        attachments: parsed.attachments,
        receivedAt: new Date(),
        raw: rawEmail.toString(),
      });

      res.status(200).send('OK');
    } catch (err) {
      console.error('[ERR] Mailparser error:', err);
      res.status(500).send('Mail parse error');
    }
  });
});

app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SendGrid Webhook server running on port ${PORT}`);
});
