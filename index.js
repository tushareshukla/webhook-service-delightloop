require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const formidable = require('formidable');
const fs = require('fs');
const { simpleParser } = require('mailparser');

const app = express();

app.use('/webhooks/sendgrid-events', express.json({ type: '*/*' }));

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

// ---- LOG HELPER ----
function log(msg, ...args) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

// ---- EVENT WEBHOOK ----
app.post('/webhooks/sendgrid-events', async (req, res) => {
  log('Received SendGrid Event Webhook', req.body);
  const events = req.body;
  if (!Array.isArray(events)) {
    log('Event webhook: Payload not array', events);
    return res.status(400).send('Payload must be array');
  }

  try {
    const db = await getDb();
    const result = await db.collection('sendgrid_events').insertMany(events, { ordered: false });
    res.status(200).send(`Stored ${result.insertedCount} events`);
  } catch (err) {
    log('[ERR] Mongo insert error for sendgrid_events:', err);
    res.status(500).send('DB error');
  }
});

// ---- INBOUND EMAIL WEBHOOK ----
app.post('/webhooks/inbound-email', (req, res) => {
  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('[ERR] Formidable parse error:', err);
      res.status(500).send('Form parse error');
      return;
    }

    // Try to read .eml as file (Send Raw ON)
    let rawEmail;
    if (files.email) {
      const emailFile = Array.isArray(files.email) ? files.email[0] : files.email;
      rawEmail = fs.readFileSync(emailFile.filepath || emailFile.path);
      console.log('[Inbound Email] Using files.email (Send Raw ON)');
    } else if (fields.email) {
      // Try to read from field (Send Raw OFF)
      rawEmail = fields.email;
      console.log('[Inbound Email] Using fields.email (Send Raw OFF)');
    }

    if (!rawEmail) {
      console.log('No email found in files or fields:', files, fields);
      res.status(400).send('No email found');
      return;
    }

    try {
      const parsed = await simpleParser(rawEmail);
      const db = await getDb();
      const result = await db.collection('inbound_emails').insertOne({
        from: parsed.from?.text,
        to: parsed.to?.text,
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        headers: Object.fromEntries(parsed.headers),
        attachments: parsed.attachments,
        receivedAt: new Date(),
        raw: rawEmail.toString(),
      });
      console.log('Inserted inbound email to MongoDB with _id:', result.insertedId);
      res.status(200).send('OK');
    } catch (err) {
      console.error('[ERR] Mailparser error:', err);
      res.status(500).send('Mail parse error');
    }
  });
});


app.get('/health', (_, res) => res.send('OK'));

const PORT =  process.env.PORT || 4000;
app.listen(PORT, () => {
  log(`SendGrid Webhook server running on port ${PORT}`);
});
