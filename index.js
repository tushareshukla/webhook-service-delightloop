require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json({ type: '*/*' })); // Accept any content-type JSON

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

app.post('/webhooks/inbound-email', async (req, res) => {
  const { from, to, subject, text, html, headers } = req.body;
  try {
    const db = await getDb();
    await db.collection('inbound_emails').insertOne({
      from, to, subject, text, html, headers,
      receivedAt: new Date(),
    });
    res.status(200).send('OK');
  } catch (err) {
    console.error('[ERR] Mongo insert error:', err);
    res.status(500).send('DB error');
  }
});

app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SendGrid Webhook server running on port ${PORT}`);
});
