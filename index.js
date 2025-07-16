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
  log('Received inbound email webhook');
  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) {
      log('[ERR] Formidable parse error:', err);
      res.status(500).send('Form parse error');
      return;
    }
    log('Parsed inbound fields:', fields);
    log('Parsed inbound files:', files);

    if (!files.email) {
      log('No email field found in files:', files);
      res.status(400).send('No email field found');
      return;
    }

    try {
      const emailFile = Array.isArray(files.email) ? files.email[0] : files.email;
      log('Processing file:', emailFile.filepath || emailFile.path);

      const rawEmail = fs.readFileSync(emailFile.filepath || emailFile.path);
      log('Read raw email file, size:', rawEmail.length);

      const parsed = await simpleParser(rawEmail);
      log('Parsed email subject:', parsed.subject);

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

      log('Inserted inbound email to MongoDB with _id:', result.insertedId);
      res.status(200).send('OK');
    } catch (err) {
      log('[ERR] Mailparser or Mongo error:', err.stack || err);
      res.status(500).send('Mail parse error');
    }
  });
});

app.get('/health', (_, res) => res.send('OK'));

const PORT =  4000;
app.listen(PORT, () => {
  log(`SendGrid Webhook server running on port ${PORT}`);
});
