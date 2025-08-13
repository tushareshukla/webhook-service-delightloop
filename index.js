require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const formidable = require('formidable');
const fs = require('fs');
const { simpleParser } = require('mailparser');
const sgMail = require('@sendgrid/mail');
const { default: axios } = require('axios');

const app = express();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

function log(msg, ...args) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
}

app.use('/webhooks/sendgrid-events', express.json({ type: '*/*' }));

// ---- EVENT WEBHOOK (for analytics if needed) ----
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

// ---- INBOUND EMAIL PARSE AND FORWARD ----
app.post('/webhooks/inbound-email', (req, res) => {
  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      log('[ERR] Formidable parse error:', err);
      return res.status(500).send('Form parse error');
    }

    let rawEmail;
    // Send Raw ON
    if (files.email) {
      const emailFile = Array.isArray(files.email) ? files.email[0] : files.email;
      rawEmail = fs.readFileSync(emailFile.filepath || emailFile.path);
      log('[Inbound Email] Using files.email (Send Raw ON)');
    }
    // Send Raw OFF
    else if (fields.email) {
      rawEmail = fields.email;
      if (Array.isArray(rawEmail)) rawEmail = rawEmail[0];
      if (typeof rawEmail === "string") rawEmail = Buffer.from(rawEmail, "utf8");
      log('[Inbound Email] Using fields.email (Send Raw OFF)');
    }

    if (!rawEmail) {
      log('No email found in files or fields:', files, fields);
      return res.status(400).send('No email found');
    }

    try {
      const parsed = await simpleParser(rawEmail);

      // ✅ New Step: Check for delightemail and delightname in email body
      const textContent = parsed.text || "";
      const emailMatch = textContent.match(/delightemail\s*:\s*([\w\.-]+@[\w\.-]+\.\w+)/i);
      const nameMatch = textContent.match(/delightname\s*:\s*(.+)/i);

      if (emailMatch && nameMatch) {
        const email = emailMatch[1].trim();
        const fullName = nameMatch[1].trim();
        const [firstName, ...lastNameParts] = fullName.split(" ");
        const lastName = lastNameParts.join(" ") || "";

        log(`[Inbound Email] Parsed recipient: ${firstName} ${lastName} <${email}>`);
        if (!email || !firstName) {
          log('[ERR] Missing email or first name in parsed content');
          return res.status(400).send('Missing email or first name');
        }
              // 2. Forward the email using SendGrid
      const toForward = {
        to: 'tushareshukla@gmail.com',
        from: 'webhook@mail.delightloop.ai',
        subject: `[FWD] ${parsed.subject}`,
        text: `${email}\n ${firstName} ${lastName}\n\n${parsed.text || ''}`,
        html: parsed.html || '',
      };

      await sgMail.send(toForward);

        // Hit your recipients/add API
        try {
          await axios.post(
            "https://api.delightloop.ai/v1/public/organizations/67cda2918a1b19597b37e2eb/campaignsNew/689c9b4aad90e9f57ddbc1de/recipients/add",
            {
              recipients: [
                {
                  firstName,
                  lastName,
                  mailId: email
                }
              ]
            },
            {
              headers: {
                "Content-Type": "application/json",
                "accept": "*/*"
              }
            }
          );
          log("[Inbound Email] Recipient added via API");
        } catch (apiErr) {
          log("[ERR] API call failed:", apiErr.message);
        }
      }

      // 1. Store in MongoDB
      const db = await getDb();
      await db.collection('inbound_emails').insertOne({
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

      // 2. Forward the email using SendGrid
      const toForward = {
        to: 'harsha@delightloop.com',
        from: 'webhook@mail.delightloop.ai',
        subject: `[FWD] ${parsed.subject}`,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(att => ({
          content: att.content.toString('base64'),
          filename: att.filename,
          type: att.contentType,
          disposition: att.contentDisposition,
        })),
      };

      await sgMail.send(toForward);

      log('Forwarded inbound email to:', process.env.FORWARD_TO);
      res.status(200).send('OK');
    } catch (err) {
      log('[ERR] Mailparser or forward error:', err);
      res.status(500).send('Mail parse/forward error');
    }
  });
});



// ---- KONNECTIFY WEBHOOK ----
app.post(
  '/konnectify/webhook',
  // parse any JSON body
  express.json(),
  async (req, res) => {
    const payload = req.body;

    if (!payload || Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    try {
      const db = await getDb();
      const result = await db
        .collection('konnectify_webhooks')
        .insertOne({
          payload,
          receivedAt: new Date(),
        });

      log('Stored Konnectify webhook:', result.insertedId);
      res.status(200).json({
        status: 'success',
        id: result.insertedId,
      });
    } catch (err) {
      log('[ERR] Konnectify webhook DB error:', err);
      res.status(500).json({ error: 'Database error' });
    }
  }
);


app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  log(`SendGrid Webhook server running on port ${PORT}`);
});
