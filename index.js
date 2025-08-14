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
    if (files.email) {
      const emailFile = Array.isArray(files.email) ? files.email[0] : files.email;
      rawEmail = fs.readFileSync(emailFile.filepath || emailFile.path);
    } else if (fields.email) {
      rawEmail = Array.isArray(fields.email) ? fields.email[0] : fields.email;
      if (typeof rawEmail === "string") rawEmail = Buffer.from(rawEmail, "utf8");
    }

    if (!rawEmail) {
      log('[ERR] No email found');
      return res.status(400).send('No email found');
    }

    try {
      const parsed = await simpleParser(rawEmail);

      // Extract custom fields from email body
      const textContent = parsed.text || "";
      const emailMatch = textContent.match(/delightemail\s*:\s*([\w\.-]+@[\w\.-]+\.\w+)/i);
      const nameMatch = textContent.match(/delightname\s*:\s*(.+)/i);

      let firstName = "", lastName = "", extractedEmail = "";

      if (emailMatch && nameMatch) {
        extractedEmail = emailMatch[1].trim();
        const fullName = nameMatch[1].trim();
        [firstName, ...lastNameParts] = fullName.split(" ");
        lastName = lastNameParts.join(" ");

        // Add to recipients API
        await axios.post(
          "https://api.delightloop.ai/v1/public/organizations/67cda2918a1b19597b37e2eb/campaignsNew/689c9b4aad90e9f57ddbc1de/recipients/add",
          { recipients: [{ firstName, lastName, mailId: extractedEmail }] }
        );

        // Send confirmation email to sender
        const senderEmail = parsed.from?.value?.[0]?.address;
        if (senderEmail) {
          await sgMail.send({
            to: senderEmail,
            from: { email: 'email-gifty@mail.delightloop.ai', name: 'Delightloop Gifty' },
            subject: `✅ Recipient added: ${firstName} ${lastName}`,
            text: `You successfully added ${firstName} ${lastName} <${extractedEmail}> to your campaign.`,
            html: `<p>You successfully added <strong>${firstName} ${lastName}</strong> &lt;${extractedEmail}&gt; to your campaign.</p>`,
          });
        }
      }

      // Store in DB
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

      // Forward email
      const toForward = {
        to: 'harsha@delightloop.com',
        from: { email: 'webhook@mail.delightloop.ai', name: 'Delightloop Webhook' },
        subject: `[FWD] ${parsed.subject || ''}`,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(att => ({
          content: att.content.toString('base64'),
          filename: att.filename || 'attachment',
          type: att.contentType,
          disposition: att.contentDisposition || 'attachment',
        })),
      };

      await sgMail.send(toForward);

      res.status(200).send('OK');
    } catch (err) {
      if (err.response?.body?.errors) {
        console.error('SendGrid API Error:', JSON.stringify(err.response.body.errors, null, 2));
      } else {
        console.error(err);
      }
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
