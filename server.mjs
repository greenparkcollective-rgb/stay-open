import express from 'express';
import nodemailer from 'nodemailer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(join(__dirname, 'submissions.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    mpp_name    TEXT,
    mpp_email   TEXT,
    riding      TEXT,
    sent_at     DATETIME DEFAULT (datetime('now','localtime'))
  )
`);

// ── MPP Lookup ────────────────────────────────────────────────────────────────

app.post('/api/lookup', async (req, res) => {
  try {
    const { postalCode } = req.body;
    if (!postalCode) return res.status(400).json({ error: 'Postal code required' });

    const clean = postalCode.replace(/\s+/g, '').toUpperCase();
    const url = `https://represent.opennorth.ca/representatives/ontario-legislature/?postcode=${clean}&format=json`;

    const resp = await fetch(url);
    if (!resp.ok) return res.status(404).json({ error: 'Could not reach MPP lookup service. Please try again.' });

    const data = await resp.json();
    const rep = data.objects?.[0];

    if (!rep) {
      return res.status(404).json({ error: 'No Ontario MPP found for this postal code. Please check the postal code and try again.' });
    }

    res.json({
      name:   rep.name,
      email:  rep.email || null,
      riding: rep.district_name,
      party:  rep.party_name || ''
    });
  } catch (err) {
    console.error('[lookup]', err.message);
    res.status(500).json({ error: 'Failed to look up MPP. Please try again.' });
  }
});

// ── Send Email + Log ──────────────────────────────────────────────────────────

app.post('/api/send', async (req, res) => {
  try {
    const { name, email, postalCode, mppName, mppEmail, riding, letter } = req.body;

    if (!name || !email || !postalCode || !mppEmail || !letter) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const htmlBody = letter
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
      .replace(/•/g, '&bull;');

    await transporter.sendMail({
      from:    `"Stay Open, Stay Alive" <${process.env.GMAIL_USER}>`,
      to:      mppEmail,
      cc:      email,
      replyTo: email,
      subject: `Please Protect Ontario's Supervised Consumption Sites — Constituent from ${riding}`,
      text:    letter,
      html:    `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.8;max-width:600px;color:#222">${htmlBody}</div>`
    });

    db.prepare(`
      INSERT INTO submissions (name, email, postal_code, mpp_name, mpp_email, riding)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, email, postalCode, mppName, mppEmail || '', riding);

    res.json({ ok: true });
  } catch (err) {
    console.error('[send]', err.message);
    res.status(500).json({ error: 'Failed to send email. Please try again.' });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD || req.query.pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send('<h2 style="font-family:sans-serif;padding:2rem">Unauthorized — add ?pw=yourpassword to the URL</h2>');
  }
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY sent_at DESC').all();
  const uniqueRidings = new Set(rows.map(r => r.riding).filter(Boolean)).size;
  const pw = req.query.pw;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stay Open — Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0d0b08;color:#f0e4c8;padding:2rem}
    h1{color:#e03d6a;font-size:1.5rem;margin-bottom:1.5rem}
    .stats{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
    .stat{background:#1a1610;border:1px solid #2e2820;border-radius:8px;padding:1rem 1.5rem}
    .stat strong{display:block;font-size:2rem;color:#2dbfbf}
    .stat span{font-size:0.8rem;color:#8a7f6e;text-transform:uppercase;letter-spacing:.05em}
    a.export{display:inline-block;margin-bottom:1.5rem;padding:.6rem 1.25rem;background:#e03d6a;color:#fff;text-decoration:none;border-radius:6px;font-size:.875rem}
    table{width:100%;border-collapse:collapse;font-size:.8rem}
    th{background:#1a1610;padding:.75rem;text-align:left;color:#2dbfbf;border-bottom:1px solid #2e2820}
    td{padding:.75rem;border-bottom:1px solid #1e1b14;word-break:break-word}
    tr:hover td{background:#1a1610}
  </style>
</head>
<body>
  <h1>Stay Open, Stay Alive — Submissions</h1>
  <div class="stats">
    <div class="stat"><strong>${rows.length}</strong><span>Letters Sent</span></div>
    <div class="stat"><strong>${uniqueRidings}</strong><span>Ridings Reached</span></div>
  </div>
  <a class="export" href="/admin/export.csv?pw=${pw}">Download CSV</a>
  <table>
    <thead><tr>
      <th>#</th><th>Name</th><th>Email</th><th>Postal Code</th>
      <th>MPP</th><th>Riding</th><th>Sent At</th>
    </tr></thead>
    <tbody>
      ${rows.map(r => `<tr>
        <td>${r.id}</td>
        <td>${r.name}</td>
        <td>${r.email}</td>
        <td>${r.postal_code}</td>
        <td>${r.mpp_name || '—'}</td>
        <td>${r.riding || '—'}</td>
        <td>${r.sent_at}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`);
});

app.get('/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY sent_at DESC').all();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    'ID,Name,Email,Postal Code,MPP Name,MPP Email,Riding,Sent At',
    ...rows.map(r => [r.id, r.name, r.email, r.postal_code, r.mpp_name, r.mpp_email, r.riding, r.sent_at].map(esc).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="stay-open-submissions.csv"');
  res.send(csv);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Stay Open running on :${PORT}`));
