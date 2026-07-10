const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");
require("dotenv").config();

  const app = express();
  const port = process.env.PORT || 3001;
  const supabaseDbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  
// const primaryDbUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
//
// if (!primaryDbUrl) {
//   console.error("Missing DATABASE_URL (or NEON_DATABASE_URL) in environment.");
//   process.exit(1);
// }

if (!supabaseDbUrl) {
  console.error("Missing DATABASE_URL (or SUPABASE_DATABASE_URL) in environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: supabaseDbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
  query_timeout: 30000
});

const resetSessions = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Masks a password for display, e.g. "paul123" -> "paul***"
// Shows at most the first 4 characters, always hides at least 1.
function maskPassword(password) {
  const str = String(password || "");
  if (!str) return "";
  const visibleLength = Math.min(4, Math.max(1, str.length - 1));
  return str.slice(0, visibleLength) + "***";
}

function formatRegistrationMessage({ name, userId, role, password }) {
  return [
    "Welcome to PRMSU Smart Campus Navigator!",
    `Name: ${name}`,
    `User ID: ${userId}`,
    `Role: ${role}`,
    `Password: ${maskPassword(password)}`,
    "Confirmation: Your account registration is successful."
  ].join("\n");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// ── Logging helpers: notification_logs / audit_logs / chat_logs ──
async function logNotification({ userId, channel, recipient, subject, message, status, errorDetail, context }) {
  try {
    await pool.query(
      `INSERT INTO notification_logs (user_id, channel, recipient, subject, message, status, error_detail, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId || null, channel, recipient, subject || null, message || null, status, errorDetail || null, context || null]
    );
  } catch (err) {
    console.error("notification_logs insert failed:", err.message);
  }
}

async function logAudit({ adminUserId, action, entityType, entityId, details, ipAddress }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        adminUserId || null,
        action,
        entityType,
        entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        ipAddress || null
      ]
    );
  } catch (err) {
    console.error("audit_logs insert failed:", err.message);
  }
}

async function logChat({ userId, question, reply, wasRateLimited, errorDetail }) {
  try {
    await pool.query(
      `INSERT INTO chat_logs (user_id, question, reply, was_rate_limited, error_detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId || null, question, reply || null, wasRateLimited === true, errorDetail || null]
    );
  } catch (err) {
    console.error("chat_logs insert failed:", err.message);
  }
}

function generateResetToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeResetEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeResetPhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getResetSessionKey(method, identifier) {
  const normalizedMethod = String(method || "").trim().toLowerCase();
  if (normalizedMethod === "sms") {
    return `${normalizedMethod}:${normalizeResetPhoneDigits(identifier)}`;
  }
  return `${normalizedMethod}:${normalizeResetEmail(identifier)}`;
}

// ── Admin check — mirrors your existing pattern of trusting client-sent
// userId and verifying against the DB (same as /api/auth/update-photo) ──
async function requireAdmin(req, res, next) {
  const adminUserId = req.body?.adminUserId || req.query?.adminUserId;
  if (!adminUserId) {
    return res.status(401).json({ ok: false, error: "Missing adminUserId." });
  }
  try {
    const result = await pool.query(
      `SELECT role FROM users WHERE LOWER(user_id) = LOWER($1)`,
      [adminUserId]
    );
    if (!result.rows.length || result.rows[0].role !== "ADMIN") {
      return res.status(403).json({ ok: false, error: "Admin access required." });
    }
    next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function formatResetOtpMessage({ name, otp, expiresMinutes }) {
  return [
    "PRMSU Navigator Password Reset",
    `Hello ${name},`,
    `Your one-time password (OTP) is: ${otp}`,
    `This code expires in ${expiresMinutes} minutes.`,
    "If you did not request a password reset, please ignore this message."
  ].join("\n");
}

function formatPasswordChangedMessage({ name }) {
  return [
    "PRMSU Navigator Password Updated",
    `Hello ${name},`,
    "Your password has been updated successfully.",
    "If you did not make this change, contact support immediately."
  ].join("\n");
}

function normalizePhPhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^0-9+]/g, "");
  if (digits.startsWith("+63")) return digits;
  if (digits.startsWith("63")) return `+${digits}`;
  if (digits.startsWith("0")) return `+63${digits.slice(1)}`;
  return digits;
}

async function sendBrevoEmail({ toEmail, toName, subject, textBody }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "PRMSU Navigator";
  if (!apiKey || !senderEmail || !toEmail) {
    return { sent: false, reason: "Brevo not configured" };
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject,
      textContent: textBody
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Brevo send failed: ${response.status} ${details}`);
  }
  return { sent: true };
}

async function sendPhilSms({ phone, message }) {
  return { sent: false, reason: "SMS disabled" };
  /*
  const apiKey = process.env.PHILSMS_API_KEY;
  const senderId = process.env.PHILSMS_SENDER || "PHILSMS";
  const endpoint = process.env.PHILSMS_ENDPOINT || "https://app.philsms.com/api/v3/sms/send";
  const normalizedPhone = normalizePhPhoneNumber(phone);
  if (!apiKey || !normalizedPhone) {
    return { sent: false, reason: "PhilSMS not configured" };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${apiKey}`
    },
    body: new URLSearchParams({
      recipient: normalizedPhone,
      sender_id: senderId,
      type: "plain",
      message
    }).toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`PhilSMS send failed: ${response.status} ${details}`);
  }
  return { sent: true };
  */
}

// ══════════════════════════════════════════
// 🤖 GEMINI CHAT ASSISTANT
// ══════════════════════════════════════════

const GEMINI_MODEL = "gemini-2.5-flash"; // free-tier model — do not swap to a Pro variant
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Customize this to describe your app so Gemini answers in-context.
// Keep it generic (no student names, IDs, or personal data get sent here).
const CHAT_SYSTEM_PROMPT = `You are a helpful assistant for the PRMSU Smart Campus Navigator app.
Help users understand how to use the map, find buildings and rooms, get directions,
and use features like the virtual tour. Keep answers short and friendly.
Do not discuss unrelated topics, and never ask for or repeat personal information.`;

async function callGemini(userMessage) {
  const response = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || "";
    const isRateLimited = response.status === 429 || errMsg.includes("RESOURCE_EXHAUSTED");
    const err = new Error(errMsg || "Gemini API error");
    err.status = response.status;
    err.isRateLimited = isRateLimited;
    throw err;
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text
    || "Sorry, I couldn't come up with a response for that. Try rephrasing your question.";
}

app.post("/api/chat", async (req, res) => {
  const { message, userId } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: "Chat assistant is not configured." });
  }

  const trimmedMessage = message.trim();

  try {
    const reply = await callGemini(trimmedMessage);
    await logChat({ userId, question: trimmedMessage, reply });
    return res.json({ ok: true, reply });
  } catch (err) {
    console.error("Gemini chat error:", err.status, err.message);

    if (err.isRateLimited) {
      const fallbackReply = "I'm getting a lot of questions right now — please try again in a few minutes, or check the app's help sections directly.";
      await logChat({ userId, question: trimmedMessage, reply: fallbackReply, wasRateLimited: true });
      return res.json({ ok: true, reply: fallbackReply });
    }

    await logChat({ userId, question: trimmedMessage, errorDetail: err.message });
    return res.status(500).json({ ok: false, error: "Something went wrong on my end. Please try again shortly." });
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      ok: true,
      databases: {
        supabase: "connected"
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/notify-registration", async (req, res) => {
  const { userId, name, email, phone, role, password } = req.body || {};
  if (!userId || !name || !email || !phone || !role || !password) {
    return res.status(400).json({ ok: false, error: "Missing required registration notification fields." });
  }

  const subject = "PRMSU Navigator Registration Confirmation";
  const fullMessage = formatRegistrationMessage({ name, userId, role, password });
  // const smsMessage = `PRMSU Reg OK. ID:${userId} Role:${role} Pass:${password}`; // SMS disabled

  const result = {
    ok: true,
    channels: {
      email: "skipped"
      // sms: "skipped" // SMS disabled
    }
  };

  try {
    const emailResult = await sendBrevoEmail({
      toEmail: email,
      toName: name,
      subject,
      textBody: fullMessage
    });
    result.channels.email = emailResult.sent ? "sent" : emailResult.reason;
  } catch (error) {
    result.channels.email = `failed: ${error.message}`;
    result.ok = false;
  }

  /* SMS DISABLED
  try {
    const smsResult = await sendPhilSms({
      phone,
      message: smsMessage
    });
    result.channels.sms = smsResult.sent ? "sent" : smsResult.reason;
  } catch (error) {
    result.channels.sms = `failed: ${error.message}`;
    result.ok = false;
  }
  */

  return res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, role, password } = req.body || {};
  if (!name || !email || !role || !password) {
    return res.status(400).json({ ok: false, error: "Missing required registration fields." });
  }

  const normalizedRole = String(role).toUpperCase();
  if (!["STUDENT", "EMPLOYEE", "VISITOR", "ADMIN"].includes(normalizedRole)) {
    return res.status(400).json({ ok: false, error: "Invalid role." });
  }

  const passwordHash = hashPassword(password);

  try {
    const insertResult = await pool.query(
      `INSERT INTO users (full_name, email, phone, role, password_hash)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING user_id, full_name, email, phone, role, created_at`,
      [name.trim(), email.trim().toLowerCase(), null, normalizedRole, passwordHash]
    );

    const user = insertResult.rows[0];

    const notifyPayload = {
      userId: user.user_id,
      name: user.full_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      password
    };

    const subject = "PRMSU Navigator Registration Confirmation";
    const fullMessage = formatRegistrationMessage(notifyPayload);
    // const smsMessage = `PRMSU Reg OK. ID:${user.user_id} Role:${user.role} Pass:${password}`; // SMS disabled
    const channels = { email: "skipped" /*, sms: "skipped" */ };

try {
      const emailResult = await sendBrevoEmail({
        toEmail: notifyPayload.email,
        toName: notifyPayload.name,
        subject,
        textBody: fullMessage
      });
      channels.email = emailResult.sent ? "sent" : emailResult.reason;
      await logNotification({
        userId: user.user_id, channel: "email", recipient: notifyPayload.email,
        subject, message: fullMessage, status: emailResult.sent ? "sent" : "skipped",
        context: "registration"
      });
    } catch (error) {
      channels.email = `failed: ${error.message}`;
      await logNotification({
        userId: user.user_id, channel: "email", recipient: notifyPayload.email,
        subject, message: fullMessage, status: "failed", errorDetail: error.message,
        context: "registration"
      });
    }

    /* SMS DISABLED
    try {
      const smsResult = await sendPhilSms({
        phone: notifyPayload.phone,
        message: smsMessage
      });
      channels.sms = smsResult.sent ? "sent" : smsResult.reason;
      await logNotification({
        userId: user.user_id, channel: "sms", recipient: notifyPayload.phone,
        message: smsMessage, status: smsResult.sent ? "sent" : "skipped",
        context: "registration"
      });
    } catch (error) {
      channels.sms = `failed: ${error.message}`;
      await logNotification({
        userId: user.user_id, channel: "sms", recipient: notifyPayload.phone,
        message: smsMessage, status: "failed", errorDetail: error.message,
        context: "registration"
      });
    }
    */

    return res.status(201).json({
      ok: true,
      user: {
        userId: user.user_id,
        name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role
      },
      notifications: channels
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, error: "Email or user ID already exists." });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ ok: false, error: "User ID and password are required." });
  }

  const normalizedIdentifier = String(identifier).trim().toLowerCase();
  const passwordHash = hashPassword(password);

  try {
    const result = await pool.query(
      `SELECT user_id, full_name, email, role
      FROM users
      WHERE (LOWER(email) = $1 OR LOWER(user_id) = $1)
        AND password_hash = $2
      LIMIT 1`,
      [normalizedIdentifier, passwordHash]
    );

    if (!result.rows.length) {
      return res.status(401).json({ ok: false, error: "Invalid user ID or password." });
    }

    const user = result.rows[0];
    return res.json({
      ok: true,
      user: {
        userId: user.user_id,
        name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/auth/forgot/request", async (req, res) => {
  const { identifier, method } = req.body || {};
  if (!identifier) {
    return res.status(400).json({ ok: false, error: "Email or phone number is required." });
  }

  // SMS DISABLED — only 'email' is accepted now
  const normalizedMethod = (method || "email").toLowerCase();
  if (!['email' /*, 'sms' */].includes(normalizedMethod)) {
    return res.status(400).json({ ok: false, error: "Invalid reset method." });
  }

  try {
    const normalizedIdentifier = normalizedMethod === "sms"
      ? normalizeResetPhoneDigits(identifier)
      : normalizeResetEmail(identifier);
    if (!normalizedIdentifier) {
      const errorLabel = normalizedMethod === 'email' ? 'Email' : 'Phone number';
      return res.status(400).json({ ok: false, error: `${errorLabel} is required.` });
    }

    const result = await pool.query(
      `SELECT user_id, full_name, email, phone
      FROM users
      WHERE ${normalizedMethod === 'email'
        ? 'LOWER(email)'
        : "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"} = $1
      LIMIT 1`,
      [normalizedIdentifier]
    );

    if (!result.rows.length) {
      const errorLabel = normalizedMethod === 'email' ? 'Email' : 'Phone number';
      return res.status(404).json({ ok: false, error: `${errorLabel} not found.` });
    }

    const user = result.rows[0];
    const otp = generateOtpCode();
    const expiresMinutes = 5;
    const expiresAt = Date.now() + expiresMinutes * 60 * 1000;

    if (normalizedMethod === "email") {
      const otpTextBody = formatResetOtpMessage({ name: user.full_name, otp, expiresMinutes });
      const emailResult = await sendBrevoEmail({
        toEmail: user.email,
        toName: user.full_name,
        subject: "PRMSU Navigator Password Reset Code",
        textBody: otpTextBody
      });
      await logNotification({
        userId: user.user_id, channel: "email", recipient: user.email,
        subject: "PRMSU Navigator Password Reset Code", message: otpTextBody,
        status: emailResult.sent ? "sent" : "failed",
        errorDetail: emailResult.sent ? null : emailResult.reason,
        context: "password_reset_otp"
      });
      if (!emailResult.sent) {
        return res.status(503).json({ ok: false, error: emailResult.reason || "Email not configured." });
      }
    }
    /* SMS DISABLED
    else {
      const smsBody = `PRMSU OTP ${otp}. Exp ${expiresMinutes}m.`;
      const smsResult = await sendPhilSms({ phone: user.phone, message: smsBody });
      await logNotification({
        userId: user.user_id, channel: "sms", recipient: user.phone,
        message: smsBody, status: smsResult.sent ? "sent" : "failed",
        errorDetail: smsResult.sent ? null : smsResult.reason,
        context: "password_reset_otp"
      });
      if (!smsResult.sent) {
        return res.status(503).json({ ok: false, error: smsResult.reason || "SMS not configured." });
      }
    }
    */

    const resetKey = getResetSessionKey(normalizedMethod, normalizedMethod === "sms" ? user.phone : user.email);
    resetSessions.set(resetKey, {
      otp,
      expiresAt,
      method: normalizedMethod,
      identifier: normalizedMethod === "sms" ? user.phone : user.email,
      verified: false,
      resetToken: null
    });

    return res.json({
      ok: true,
      email: user.email,
      identifier: normalizedMethod === "sms" ? user.phone : user.email,
      method: normalizedMethod,
      expiresInSeconds: expiresMinutes * 60,
      delivery: { method: normalizedMethod, status: "sent" }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/auth/forgot/verify", async (req, res) => {
  const { identifier, email, method, otp } = req.body || {};
  const resetIdentifier = identifier || email;
  const resetMethod = method || "email";
  if (!resetIdentifier || !otp) {
    return res.status(400).json({ ok: false, error: "Email or phone number and OTP are required." });
  }

  const entry = resetSessions.get(getResetSessionKey(resetMethod, resetIdentifier));
  if (!entry) {
    return res.status(400).json({ ok: false, error: "Reset request not found." });
  }

  if (Date.now() > entry.expiresAt) {
    resetSessions.delete(getResetSessionKey(resetMethod, resetIdentifier));
    return res.status(400).json({ ok: false, error: "OTP expired. Please request a new code." });
  }

  if (String(otp).trim() !== entry.otp) {
    return res.status(400).json({ ok: false, error: "Invalid OTP code." });
  }

  const resetToken = generateResetToken();
  resetSessions.set(getResetSessionKey(resetMethod, resetIdentifier), {
    ...entry,
    verified: true,
    resetToken
  });

  return res.json({ ok: true, resetToken });
});

app.post("/api/auth/forgot/reset", async (req, res) => {
  const { identifier, email, method, resetToken, newPassword } = req.body || {};
  const resetIdentifier = identifier || email;
  const resetMethod = method || "email";
  if (!resetIdentifier || !resetToken || !newPassword) {
    return res.status(400).json({ ok: false, error: "Missing reset details." });
  }

  const key = getResetSessionKey(resetMethod, resetIdentifier);
  const entry = resetSessions.get(key);
  if (!entry || !entry.verified || entry.resetToken !== resetToken) {
    return res.status(400).json({ ok: false, error: "Reset session invalid or expired." });
  }

  if (Date.now() > entry.expiresAt) {
    resetSessions.delete(key);
    return res.status(400).json({ ok: false, error: "Reset session expired. Please request a new code." });
  }

  try {
    const result = await pool.query(
      `UPDATE users
      SET password_hash = $1
      WHERE ${entry.method === "sms"
        ? "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"
        : "LOWER(email)"} = $2
      RETURNING full_name, email`,
      [
        hashPassword(newPassword),
        entry.method === "sms" ? normalizeResetPhoneDigits(entry.identifier) : normalizeResetEmail(entry.identifier)
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "User not found." });
    }

    const user = result.rows[0];
    const notifications = { email: "skipped" };

    const changedTextBody = formatPasswordChangedMessage({ name: user.full_name });
    try {
      const emailResult = await sendBrevoEmail({
        toEmail: user.email,
        toName: user.full_name,
        subject: "PRMSU Navigator Password Updated",
        textBody: changedTextBody
      });
      notifications.email = emailResult.sent ? "sent" : emailResult.reason;
      await logNotification({
        channel: "email", recipient: user.email, subject: "PRMSU Navigator Password Updated",
        message: changedTextBody, status: emailResult.sent ? "sent" : "skipped",
        context: "password_changed"
      });
    } catch (error) {
      notifications.email = `failed: ${error.message}`;
      await logNotification({
        channel: "email", recipient: user.email, subject: "PRMSU Navigator Password Updated",
        message: changedTextBody, status: "failed", errorDetail: error.message,
        context: "password_changed"
      });
    }

    resetSessions.delete(key);
    return res.json({ ok: true, notifications });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/datasets", async (req, res) => {
  const { title, description, payload } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO datasets (title, description, payload)
      VALUES ($1, $2, $3)
      RETURNING id, title, description, payload, created_at`,
      [title, description || null, payload || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/datasets", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, description, payload, created_at FROM datasets ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── PROFILE: Get profile from DB ──
app.get("/api/auth/profile/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT user_id, full_name, email, phone, role, photo
            FROM users WHERE LOWER(user_id) = LOWER($1)`,
            [userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        const u = result.rows[0];
        return res.json({
            ok: true,
            user: {
                userId: u.user_id,
                name:   u.full_name,
                email:  u.email,
                phone:  u.phone  || "",
                role:   u.role,
                photo:  u.photo  || ""
            }
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Update name, email, phone ──
app.post("/api/auth/update-profile", async (req, res) => {
    const { userId, name, email, phone } = req.body || {};
    if (!userId || !name || !email) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        const result = await pool.query(
            `UPDATE users
            SET full_name = $1, email = $2, phone = $3
            WHERE LOWER(user_id) = LOWER($4)
            RETURNING user_id, full_name, email, phone, role`,
            [name.trim(), email.trim().toLowerCase(), phone?.trim() || null, userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        const u = result.rows[0];
        return res.json({
            ok: true,
            user: {
                userId: u.user_id,
                name:   u.full_name,
                email:  u.email,
                phone:  u.phone || ""
            }
        });
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ ok: false, error: "Email already in use by another account." });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Update photo ──
app.post("/api/auth/update-photo", async (req, res) => {
    const { userId, photo } = req.body || {};
    if (!userId || !photo) {
        return res.status(400).json({ ok: false, error: "Missing userId or photo." });
    }
    if (photo.length > 3 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: "Photo too large (max ~2MB)." });
    }
    try {
        const result = await pool.query(
            `UPDATE users SET photo = $1
            WHERE LOWER(user_id) = LOWER($2)
            RETURNING user_id`,
            [photo, userId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ── PROFILE: Change password ──
app.post("/api/auth/change-password", async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body || {};
    if (!userId || !currentPassword || !newPassword) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        // Verify current password
        const check = await pool.query(
            `SELECT user_id FROM users
            WHERE LOWER(user_id) = LOWER($1) AND password_hash = $2`,
            [userId, hashPassword(currentPassword)]
        );
        if (!check.rows.length) {
            return res.status(401).json({ ok: false, error: "Current password is incorrect." });
        }
        // Update to new password
        await pool.query(
            `UPDATE users SET password_hash = $1
            WHERE LOWER(user_id) = LOWER($2)`,
            [hashPassword(newPassword), userId]
        );
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

app.post("/api/routes/record", async (req, res) => {
    const { userId, destination, distance, duration, isRoom, campus } = req.body || {};
    if (!userId || !destination) {
        return res.status(400).json({ ok: false, error: "Missing required fields." });
    }
    try {
        await pool.query(
            `INSERT INTO route_history
            (user_id, destination_name, distance_m, duration_s, is_room, campus, navigated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                userId,
                String(destination),
                Math.round(Number(distance) || 0),
                Math.round(Number(duration) || 0),
                isRoom === true || isRoom === 'true',
                campus || 'iba'
            ]
        );
        return res.json({ ok: true });
    } catch (err) {
        console.error('Route record error:', err.message, err.detail);
        return res.status(500).json({ ok: false, error: err.message });
    }
});


// ── ROUTE HISTORY: Get count for a user ──
app.get("/api/routes/count/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS total FROM route_history WHERE LOWER(user_id) = LOWER($1)`,
            [userId]
        );
        return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ══════════════════════════════════════════
// 📢 ANNOUNCEMENTS
// ══════════════════════════════════════════

app.get("/api/announcements", async (req, res) => {
  const activeOnly = req.query.active === "true";
  try {
    const result = await pool.query(
      activeOnly
        ? `SELECT * FROM announcements WHERE is_active = true ORDER BY created_at DESC`
        : `SELECT * FROM announcements ORDER BY created_at DESC`
    );
    return res.json({ ok: true, announcements: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/announcements", requireAdmin, async (req, res) => {
  const { title, message, type, adminUserId } = req.body || {};
  if (!title || !message) {
    return res.status(400).json({ ok: false, error: "Title and message are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), message.trim(), type || "info", adminUserId]
    );
    await logAudit({
      adminUserId, action: "create", entityType: "announcement",
      entityId: result.rows[0].id, details: result.rows[0]
    });
    return res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/announcements/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, message, type, isActive } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE announcements
      SET title = COALESCE($1, title),
          message = COALESCE($2, message),
          type = COALESCE($3, type),
          is_active = COALESCE($4, is_active),
          updated_at = NOW()
      WHERE id = $5
       RETURNING *`,
      [title, message, type, isActive, id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Announcement not found." });
    return res.json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/announcements/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM announcements WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Announcement not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════
// 📅 EVENTS
// ══════════════════════════════════════════

app.get("/api/events", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM events ORDER BY event_date ASC, start_time ASC`);
    return res.json({ ok: true, events: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/events", requireAdmin, async (req, res) => {
  const { title, description, location, eventDate, startTime, endTime, adminUserId } = req.body || {};
  if (!title || !eventDate) {
    return res.status(400).json({ ok: false, error: "Title and event date are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, location, event_date, start_time, end_time, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), description || null, location || null, eventDate, startTime || null, endTime || null, adminUserId]
    );
    return res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.put("/api/events/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, description, location, eventDate, startTime, endTime } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE events
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          location = COALESCE($3, location),
          event_date = COALESCE($4, event_date),
          start_time = COALESCE($5, start_time),
          end_time = COALESCE($6, end_time),
          updated_at = NOW()
      WHERE id = $7
       RETURNING *`,
      [title, description, location, eventDate, startTime, endTime, id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Event not found." });
    return res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/events/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Event not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════
// 🔧 ADMIN ROUTES
// ══════════════════════════════════════════

app.get("/api/admin/users", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, full_name, email, role, created_at FROM users ORDER BY created_at DESC`
    );
    return res.json({ ok: true, users: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/stats/users", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) AS total FROM users`);
    return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/stats/routes", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) AS total FROM route_history`);
    return res.json({ ok: true, total: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/announcements", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM announcements ORDER BY created_at DESC`);
    return res.json({ ok: true, announcements: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/announcements", async (req, res) => {
  const { message, type, expires_at } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: "Message is required." });
  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, expires_at, created_by, is_active)
      VALUES ($1, $2, $3, $4, 'admin', true) RETURNING *`,
      [message.trim(), message.trim(), type || "info", expires_at || null]
    );
    return res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/announcements/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM announcements WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/events", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM events ORDER BY start_at ASC NULLS LAST`);
    return res.json({ ok: true, events: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/events", async (req, res) => {
  const { title, location, start_at, end_at, description } = req.body || {};
  if (!title || !start_at) return res.status(400).json({ ok: false, error: "Title and start time are required." });
  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, location, start_at, end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING *`,
      [title.trim(), description || null, location || null, start_at, end_at || null]
    );
    return res.status(201).json({ ok: true, event: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/events/:id", async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM events WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM rooms ORDER BY building, name'
    );
    res.json({ ok: true, rooms: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST add a room
app.post('/api/admin/rooms', async (req, res) => {
  const { building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y } = req.body;
  if (!building || !name) return res.status(400).json({ ok: false, error: 'building and name required' });
  try {
    const result = await pool.query(
      `INSERT INTO rooms (building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [building, name, floor || '—', instructor || null,
      lat || null, lng || null,
      icon_offset_x || 0, icon_offset_y || 0]
    );
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT edit a room
app.put('/api/admin/rooms/:id', async (req, res) => {
  const { building, name, floor, instructor, lat, lng, icon_offset_x, icon_offset_y } = req.body;
  try {
    const result = await pool.query(
      `UPDATE rooms SET building=$1, name=$2, floor=$3, instructor=$4,
      lat=$5, lng=$6, icon_offset_x=$7, icon_offset_y=$8
       WHERE id=$9 RETURNING *`,
      [building, name, floor || '—', instructor || null,
      lat || null, lng || null,
      icon_offset_x || 0, icon_offset_y || 0,
      req.params.id]
    );
    res.json({ ok: true, room: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// DELETE a room
app.delete('/api/admin/rooms/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rooms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET all buildings
app.get('/api/buildings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM buildings ORDER BY name');
    res.json({ ok: true, buildings: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST add a building
app.post('/api/admin/buildings', async (req, res) => {
  const { name, short_name, type, lat, lng } = req.body;
  if (!name || !short_name) return res.status(400).json({ ok: false, error: 'name and short_name required' });
  try {
    const result = await pool.query(
      'INSERT INTO buildings (name, short_name, type, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, short_name, type || 'department', lat || null, lng || null]
    );
    res.json({ ok: true, building: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT edit a building
app.put('/api/admin/buildings/:id', async (req, res) => {
  const { name, short_name, type, lat, lng } = req.body;
  try {
    const result = await pool.query(
      'UPDATE buildings SET name=$1, short_name=$2, type=$3, lat=$4, lng=$5 WHERE id=$6 RETURNING *',
      [name, short_name, type || 'department', lat || null, lng || null, req.params.id]
    );
    res.json({ ok: true, building: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE a building
app.delete('/api/admin/buildings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM buildings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Seed buildings
app.post('/api/admin/seed-buildings', async (req, res) => {
  const buildings = [
    { name: 'College of Communication and Information Technology', short_name: 'CCIT', type: 'department', lat: 15.31695, lng: 119.98315 },
    { name: 'College of Nursing', short_name: 'CON', type: 'department', lat: 15.31720, lng: 119.98264 },
    { name: 'College of Engineering', short_name: 'COE', type: 'department', lat: 15.31771, lng: 119.98208 },
    { name: 'College of Physical Education', short_name: 'CPE', type: 'department', lat: 15.31836, lng: 119.98239 },
    { name: 'Gymnasium', short_name: 'GYM', type: 'facilities', lat: 15.31870, lng: 119.98300 },
    { name: 'Science and Engineering Laboratory Building', short_name: 'SELB', type: 'department', lat: 15.31846, lng: 119.98186 },
    { name: 'College of Business Accountancy and Public Administration', short_name: 'CBAPA', type: 'department', lat: 15.31918, lng: 119.98230 },
    { name: 'College of Law', short_name: 'LAW', type: 'department', lat: 15.31900, lng: 119.98270 },
    { name: 'Admin Building', short_name: 'Admin Building', type: 'administration', lat: 15.31835, lng: 119.98360 },
    { name: 'President Ramon Magsaysay Statue', short_name: 'STATUE', type: 'landmark', lat: 15.31860, lng: 119.98388 },
    { name: 'PRMSU Registrar Building', short_name: 'REGISTRAR', type: 'administration', lat: 15.31790, lng: 119.98330 },
    { name: 'E-Library', short_name: 'E-Library', type: 'facilities', lat: 15.31810, lng: 119.98350 },
    { name: 'College of Tourism and Hospitality Management', short_name: 'CTHM', type: 'department', lat: 15.31960, lng: 119.98460 },
    { name: 'Gender and Development Center', short_name: 'GAD Center', type: 'office', lat: 15.31780, lng: 119.98290 },
    { name: 'Cafeteria', short_name: 'Cafeteria', type: 'facilities', lat: 15.31900, lng: 119.98340 },
    { name: 'College of Industrial Technology', short_name: 'CIT', type: 'department', lat: 15.31771, lng: 119.98364 },
    { name: 'College of Teacher Education', short_name: 'CTE', type: 'department', lat: 15.31836, lng: 119.98499 },
    { name: 'University Health Clinic', short_name: 'Clinic', type: 'facilities', lat: 15.31750, lng: 119.98310 },
    { name: 'Entrance Gate', short_name: 'ENTRANCE', type: 'landmark', lat: 15.31760, lng: 119.98450 },
    { name: 'Exit Gate', short_name: 'EXIT', type: 'landmark', lat: 15.31740, lng: 119.98440 },
    { name: 'PRMSU Dormitory', short_name: 'Dormitory', type: 'facilities', lat: 15.31820, lng: 119.98200 },
    { name: 'New Gymnasium', short_name: 'NEW GYM', type: 'facilities', lat: 15.31880, lng: 119.98310 },
    { name: 'College of Accountancy and Business Administration', short_name: 'CABA', type: 'department', lat: 15.31910, lng: 119.98250 },
    { name: 'RMTU Multipurpose Cooperative', short_name: 'Cooperative', type: 'facilities', lat: 15.31760, lng: 119.98380 },
    { name: 'Psychology Annex Building', short_name: 'Annex', type: 'department', lat: 15.31905, lng: 119.98458 },
    { name: 'College of Arts and Sciences', short_name: 'CAS', type: 'department', lat: 15.31824, lng: 119.98456 },
    { name: 'Automotive Technology', short_name: 'AUTO', type: 'department', lat: 15.31800, lng: 119.98180 },
    { name: 'Food Technology / Food Service Management', short_name: 'FSMT', type: 'department', lat: 15.31810, lng: 119.98390 },
    { name: 'Mechanical Technology', short_name: 'MECH', type: 'department', lat: 15.31790, lng: 119.98170 },
    { name: 'New Building', short_name: 'NEW BLDG', type: 'department', lat: 15.31850, lng: 119.98420 },
    { name: 'Civil Technology', short_name: 'CIVIL', type: 'department', lat: 15.31780, lng: 119.98160 },
    { name: 'Science-Based Education Building', short_name: 'SBEB', type: 'department', lat: 15.31860, lng: 119.98470 },
    { name: 'Drafting Technology', short_name: 'DRAFTING', type: 'department', lat: 15.31770, lng: 119.98150 },
    { name: 'Graduate School', short_name: 'Graduate School', type: 'department', lat: 15.31898, lng: 119.98375 },
    { name: 'Nursing Skills Laboratory Building', short_name: 'NSLB', type: 'department', lat: 15.31730, lng: 119.98270 },
    { name: 'ROTC Office', short_name: 'ROTC', type: 'office', lat: 15.31760, lng: 119.98200 },
    { name: 'Student Services and Quality Assurance Building', short_name: 'SSQAB', type: 'office', lat: 15.31927, lng: 119.98390 },
    { name: 'Tourism and Hospitality Management Building', short_name: 'THM', type: 'department', lat: 15.31970, lng: 119.98470 },
  ];
  try {
    await pool.query('DELETE FROM buildings');
    for (const b of buildings) {
      await pool.query(
        'INSERT INTO buildings (name, short_name, type, lat, lng) VALUES ($1,$2,$3,$4,$5)',
        [b.name, b.short_name, b.type, b.lat || null, b.lng || null]
      );
    }
    res.json({ ok: true, inserted: buildings.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/seed-room-coords', async (req, res) => {
const coords = [
  // ── CCIT ──
  { name: 'SBO Office',                    building: 'CCIT', lat: 15.31758, lng: 119.98223, floor: 'Ground Floor' },
  { name: 'CCIT Room 5',                   building: 'CCIT', lat: 15.31754, lng: 119.98227, floor: 'Ground Floor' },
  { name: 'CCIT Room 4',                   building: 'CCIT', lat: 15.31751, lng: 119.98231, floor: 'Ground Floor' },
  { name: 'CCIT Room 3',                   building: 'CCIT', lat: 15.31747, lng: 119.98235, floor: 'Ground Floor' },
  { name: 'CCIT Room 2',                   building: 'CCIT', lat: 15.31744, lng: 119.98239, floor: 'Ground Floor' },
  { name: 'CCIT Room 1',                   building: 'CCIT', lat: 15.31740, lng: 119.98243, floor: 'Ground Floor' },
  { name: 'CCIT Room 11',                  building: 'CCIT', lat: 15.31758, lng: 119.98221, floor: '2nd Floor' },
  { name: 'CCIT Room 10',                  building: 'CCIT', lat: 15.31754, lng: 119.98225, floor: '2nd Floor' },
  { name: 'CCIT Room 9',                   building: 'CCIT', lat: 15.31751, lng: 119.98229, floor: '2nd Floor' },
  { name: 'CCIT Room 8',                   building: 'CCIT', lat: 15.31747, lng: 119.98233, floor: '2nd Floor' },
  { name: 'CCIT Room 7',                   building: 'CCIT', lat: 15.31744, lng: 119.98237, floor: '2nd Floor' },
  { name: 'CCIT Room 6',                   building: 'CCIT', lat: 15.31740, lng: 119.98240, floor: '2nd Floor' },
  { name: 'Storage Room',                  building: 'CCIT', lat: 15.31688, lng: 119.98322, floor: 'Ground Floor' },
  { name: 'Faculty Office',                building: 'CCIT', lat: 15.31690, lng: 119.98320, floor: 'Ground Floor' },
  { name: "Programs Chair's Office",       building: 'CCIT', lat: 15.31692, lng: 119.98318, floor: 'Ground Floor' },
  { name: 'Multi Media Center',            building: 'CCIT', lat: 15.31694, lng: 119.98316, floor: 'Ground Floor' },
  { name: "Dean's Office",                 building: 'CCIT', lat: 15.31696, lng: 119.98314, floor: 'Ground Floor' },
  { name: 'Storage Room',                  building: 'CCIT', lat: 15.31698, lng: 119.98312, floor: 'Ground Floor' },
  { name: 'Comfort Room (F/M)',            building: 'CCIT', lat: 15.31700, lng: 119.98310, floor: 'Ground Floor' },
  { name: "Programs Chair's Office",       building: 'CCIT', lat: 15.31702, lng: 119.98308, floor: 'Ground Floor' },
  { name: 'Hybrid Laboratory 1',           building: 'CCIT', lat: 15.31695, lng: 119.98330, floor: '2nd Floor' },
  { name: 'Computer Laboratory 1',         building: 'CCIT', lat: 15.31697, lng: 119.98328, floor: '2nd Floor' },
  { name: 'Hybrid Laboratory 2',           building: 'CCIT', lat: 15.31699, lng: 119.98326, floor: '2nd Floor' },
  { name: 'Laboratory Custodian Office',   building: 'CCIT', lat: 15.31701, lng: 119.98324, floor: '2nd Floor' },
  { name: 'Comfort Room (F/M)',            building: 'CCIT', lat: 15.31703, lng: 119.98322, floor: '2nd Floor' },
  { name: 'Faculty',                       building: 'CCIT', lat: 15.31705, lng: 119.98320, floor: '2nd Floor' },
  { name: 'Hybrid Laboratory 3',           building: 'CCIT', lat: 15.31695, lng: 119.98330, floor: '3rd Floor' },
  { name: 'Computer Laboratory 3',         building: 'CCIT', lat: 15.31697, lng: 119.98328, floor: '3rd Floor' },
  { name: 'Computer Laboratory 2',         building: 'CCIT', lat: 15.31699, lng: 119.98326, floor: '3rd Floor' },
  { name: 'Extension Office',              building: 'CCIT', lat: 15.31701, lng: 119.98324, floor: '3rd Floor' },
  { name: 'Comfort Room (F/M)',            building: 'CCIT', lat: 15.31703, lng: 119.98322, floor: '3rd Floor' },
  { name: 'Faculty',                       building: 'CCIT', lat: 15.31705, lng: 119.98320, floor: '3rd Floor' },
  // ── CON ──
  { name: 'Lecture Room 6',               building: 'CON', lat: 15.31735, lng: 119.98249, floor: '2nd Floor' },
  { name: 'Lecture Room 5',               building: 'CON', lat: 15.31730, lng: 119.98254, floor: '2nd Floor' },
  { name: 'Lecture Room 4',               building: 'CON', lat: 15.31725, lng: 119.98259, floor: '2nd Floor' },
  { name: 'Lecture Room 3',               building: 'CON', lat: 15.31720, lng: 119.98264, floor: '2nd Floor' },
  { name: 'Lecture Room 2',               building: 'CON', lat: 15.31715, lng: 119.98269, floor: '2nd Floor' },
  { name: 'Lecture Room 1',               building: 'CON', lat: 15.31710, lng: 119.98274, floor: '2nd Floor' },
  { name: 'CSBO Office',                  building: 'CON', lat: 15.31705, lng: 119.98279, floor: '2nd Floor' },
  { name: "Dean's Office/Faculty Room",   building: 'CON', lat: 15.31705, lng: 119.98277, floor: 'Ground Floor' },
  { name: 'Science Laboratory',           building: 'CON', lat: 15.31710, lng: 119.98272, floor: 'Ground Floor' },
  { name: 'Old Skill Laboratory',         building: 'CON', lat: 15.31715, lng: 119.98267, floor: 'Ground Floor' },
  { name: 'Accreditation Room',           building: 'CON', lat: 15.31720, lng: 119.98262, floor: 'Ground Floor' },
  // ── COE ──
  { name: 'COE 103 CMR&SOIL Mechanics Laboratory',    building: 'COE', lat: 15.31766, lng: 119.98213, floor: 'Ground Floor' },
  { name: 'COE 102 Hydraulics Laboratory',            building: 'COE', lat: 15.31771, lng: 119.98208, floor: 'Ground Floor' },
  { name: 'Civil Engineering Department Faculty Room', building: 'COE', lat: 15.31776, lng: 119.98203, floor: 'Ground Floor' },
  { name: 'Comfort Room (F/M)',                       building: 'COE', lat: 15.31781, lng: 119.98198, floor: 'Ground Floor' },
  { name: 'Storage Room',                             building: 'COE', lat: 15.31786, lng: 119.98193, floor: '1st Floor' },
  { name: 'COE Computer Laboratory',                  building: 'COE', lat: 15.31763, lng: 119.98214, floor: '2nd Floor' },
  { name: 'COE 201 Classroom',                        building: 'COE', lat: 15.31768, lng: 119.98209, floor: '2nd Floor' },
  { name: 'COE 202 Classroom',                        building: 'COE', lat: 15.31773, lng: 119.98204, floor: '2nd Floor' },
  { name: 'COE 203 Classroom',                        building: 'COE', lat: 15.31778, lng: 119.98199, floor: '2nd Floor' },
  // ── CPE ──
  { name: 'Faculty Room P.E Department', building: 'CPE', lat: 15.31841, lng: 119.98239, floor: '1st Floor' },
  { name: 'BPED 1B',                     building: 'CPE', lat: 15.31802, lng: 119.98239, floor: '1st Floor' },
  { name: 'BPED',                        building: 'CPE', lat: 15.31795, lng: 119.98239, floor: '1st Floor' },
  { name: 'Comfort Room (F/M)',          building: 'CPE', lat: 15.31795, lng: 119.98239, floor: '1st Floor' },
  { name: 'NSTP Office',                 building: 'CPE', lat: 15.31836, lng: 119.98239, floor: '2nd Floor' },
  { name: 'Crim P.E Area',               building: 'CPE', lat: 15.31836, lng: 119.98232, floor: '2nd Floor' },
  { name: 'CRIM Scene Room Station 3',   building: 'CPE', lat: 15.31836, lng: 119.98225, floor: '2nd Floor' },
  { name: 'Comfort Room (F/M)',          building: 'CPE', lat: 15.31836, lng: 119.98218, floor: '2nd Floor' },
  // ── SELB ──
  { name: "SELB 100 Dean's Office",                            building: 'SELB', lat: 15.31832, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'SELB 101 Mechanical Engineering Department',        building: 'SELB', lat: 15.31839, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'SELB 102 Audio Visual Room',                        building: 'SELB', lat: 15.31846, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'SELB 103 Mechanical Engineering Laboratory Room 1', building: 'SELB', lat: 15.31853, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'SELB 104 Mechanical Engineering Laboratory Room 2', building: 'SELB', lat: 15.31860, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'Comfort Room',                                      building: 'SELB', lat: 15.31867, lng: 119.98186, floor: 'Ground Floor' },
  { name: 'SELB 205 Electrical Engineering Department',        building: 'SELB', lat: 15.31832, lng: 119.98184, floor: '2nd Floor' },
  { name: 'SELB 204 Physical Lab',                             building: 'SELB', lat: 15.31839, lng: 119.98184, floor: '2nd Floor' },
  { name: 'SELB 203 EE and ECE Laboratory Room',               building: 'SELB', lat: 15.31846, lng: 119.98184, floor: '2nd Floor' },
  { name: 'SELB 202 Electrical Engineering Laboratory Room 2', building: 'SELB', lat: 15.31853, lng: 119.98184, floor: '2nd Floor' },
  { name: 'SELB 201 Electrical Engineering Laboratory Room 1', building: 'SELB', lat: 15.31860, lng: 119.98184, floor: '2nd Floor' },
  { name: 'Comfort Room',                                      building: 'SELB', lat: 15.31867, lng: 119.98184, floor: '2nd Floor' },
  { name: 'SELB 301 Computer Engineering Department',          building: 'SELB', lat: 15.31832, lng: 119.98182, floor: '3rd Floor' },
  { name: 'SELB 302A Software Engineering Laboratory Room',    building: 'SELB', lat: 15.31839, lng: 119.98182, floor: '3rd Floor' },
  { name: 'SELB 303B Networking Laboratory Room',              building: 'SELB', lat: 15.31846, lng: 119.98182, floor: '3rd Floor' },
  { name: 'SELB 304 Chemistry Laboratory Room',                building: 'SELB', lat: 15.31853, lng: 119.98182, floor: '3rd Floor' },
  { name: 'SELB 305 Digital Electronics Laboratory Room',      building: 'SELB', lat: 15.31860, lng: 119.98182, floor: '3rd Floor' },
  { name: 'Comfort Room',                                      building: 'SELB', lat: 15.31867, lng: 119.98182, floor: '3rd Floor' },
  // ── CBAPA ──
  { name: 'Comfort Room',              building: 'CBAPA', lat: 15.31919, lng: 119.98216, floor: 'Ground Floor' },
  { name: 'CBAPA Faculty',             building: 'CBAPA', lat: 15.31918, lng: 119.98222, floor: 'Ground Floor' },
  { name: 'CBAPA Room 101',            building: 'CBAPA', lat: 15.31917, lng: 119.98228, floor: 'Ground Floor' },
  { name: 'CBAPA ROOM 102',            building: 'CBAPA', lat: 15.31916, lng: 119.98234, floor: 'Ground Floor' },
  { name: 'Research Office',           building: 'CBAPA', lat: 15.31915, lng: 119.98240, floor: 'Ground Floor' },
  { name: 'Supply Room',               building: 'CBAPA', lat: 15.31921, lng: 119.98216, floor: '2nd Floor' },
  { name: 'CBAPA Room 203',            building: 'CBAPA', lat: 15.31920, lng: 119.98222, floor: '2nd Floor' },
  { name: 'CBAPA Room 202',            building: 'CBAPA', lat: 15.31919, lng: 119.98228, floor: '2nd Floor' },
  { name: 'CBAPA ROOM 201',            building: 'CBAPA', lat: 15.31918, lng: 119.98234, floor: '2nd Floor' },
  { name: 'Accreditation Room',        building: 'CBAPA', lat: 15.31917, lng: 119.98240, floor: '2nd Floor' },
  { name: 'Comfort Room',              building: 'CBAPA', lat: 15.31923, lng: 119.98216, floor: '3rd Floor' },
  { name: 'CBAPA AVR',                 building: 'CBAPA', lat: 15.31922, lng: 119.98222, floor: '3rd Floor' },
  { name: 'CBAPA Room 301',            building: 'CBAPA', lat: 15.31921, lng: 119.98228, floor: '3rd Floor' },
  { name: 'CBAPA ROOM 302',            building: 'CBAPA', lat: 15.31920, lng: 119.98234, floor: '3rd Floor' },
  { name: 'Extension Service Office',  building: 'CBAPA', lat: 15.31919, lng: 119.98240, floor: '3rd Floor' },
  // ── Admin Building ──
  { name: 'Collecting and Disbursing Office',                                      building: 'Admin Building', lat: 15.31848, lng: 119.98348, floor: 'Ground Floor' },
  { name: 'Office of the Resident Auditor',                                        building: 'Admin Building', lat: 15.31844, lng: 119.98354, floor: 'Ground Floor' },
  { name: 'Cashier',                                                               building: 'Admin Building', lat: 15.31840, lng: 119.98360, floor: 'Ground Floor' },
  { name: 'Budgeting Services Office',                                             building: 'Admin Building', lat: 15.31836, lng: 119.98366, floor: 'Ground Floor' },
  { name: 'Human Resources Management Office',                                     building: 'Admin Building', lat: 15.31832, lng: 119.98372, floor: 'Ground Floor' },
  { name: 'Accounting Services Office',                                            building: 'Admin Building', lat: 15.31828, lng: 119.98378, floor: 'Ground Floor' },
  { name: 'Chief Administrative Officer Director, Admin Services',                 building: 'Admin Building', lat: 15.31824, lng: 119.98384, floor: 'Ground Floor' },
  { name: 'Comfort Room',                                                          building: 'Admin Building', lat: 15.31820, lng: 119.98390, floor: 'Ground Floor' },
  { name: 'Procurement Management Office',                                         building: 'Admin Building', lat: 15.31842, lng: 119.98340, floor: '2nd Floor' },
  { name: 'Office of the Vice President for Planning and Quality Management',      building: 'Admin Building', lat: 15.31839, lng: 119.98344, floor: '2nd Floor' },
  { name: 'Office of the Vice President for Academic Affairs',                     building: 'Admin Building', lat: 15.31836, lng: 119.98348, floor: '2nd Floor' },
  { name: 'Office of the Vice President for Research and Development',             building: 'Admin Building', lat: 15.31833, lng: 119.98352, floor: '2nd Floor' },
  { name: 'Office of the University President',                                    building: 'Admin Building', lat: 15.31830, lng: 119.98356, floor: '2nd Floor' },
  { name: 'Office of the Vice President for Administration and Finance',           building: 'Admin Building', lat: 15.31827, lng: 119.98360, floor: '2nd Floor' },
  { name: 'Office of the University and Board Secretary',                          building: 'Admin Building', lat: 15.31824, lng: 119.98364, floor: '2nd Floor' },
  { name: 'Interview Room',                                                        building: 'Admin Building', lat: 15.31821, lng: 119.98368, floor: '2nd Floor' },
  { name: 'Information & Communications Technology Office',                        building: 'Admin Building', lat: 15.31835, lng: 119.98334, floor: '3rd Floor' },
  { name: 'Internal Audit Services Office',                                        building: 'Admin Building', lat: 15.31832, lng: 119.98338, floor: '3rd Floor' },
  { name: 'Futures Thinking Innovation Workspace',                                 building: 'Admin Building', lat: 15.31829, lng: 119.98342, floor: '3rd Floor' },
  { name: 'Statistical Services Intellectual Property Service Office',             building: 'Admin Building', lat: 15.31826, lng: 119.98346, floor: '3rd Floor' },
  { name: 'Office of the University and Board Secretary (Records Room)',           building: 'Admin Building', lat: 15.31823, lng: 119.98350, floor: '3rd Floor' },
  { name: 'Research and Development, Extension and Production Services Office',    building: 'Admin Building', lat: 15.31820, lng: 119.98354, floor: '3rd Floor' },
  { name: 'Project Development Office',                                            building: 'Admin Building', lat: 15.31817, lng: 119.98358, floor: '3rd Floor' },
  { name: 'Records Management Services Office',                                    building: 'Admin Building', lat: 15.31835, lng: 119.98334, floor: '4th Floor' },
  // ── CTHM ──
  { name: "Dean's Office",                   building: 'CTHM', lat: 15.31960, lng: 119.98450, floor: 'Ground Floor' },
  { name: 'CTHM Room 107 & CTHM AVR Room',  building: 'CTHM', lat: 15.31966, lng: 119.98441, floor: 'Ground Floor' },
  { name: 'CTHM Room 109',                   building: 'CTHM', lat: 15.31972, lng: 119.98432, floor: 'Ground Floor' },
  { name: 'CTHM Room 110',                   building: 'CTHM', lat: 15.31978, lng: 119.98423, floor: 'Ground Floor' },
  { name: 'Office of the Campus Director',   building: 'CTHM', lat: 15.31953, lng: 119.98459, floor: 'Ground Floor' },
  { name: 'CTHM DID Room',                   building: 'CTHM', lat: 15.31948, lng: 119.98466, floor: 'Ground Floor' },
  { name: 'CTHM Room 102',                   building: 'CTHM', lat: 15.31943, lng: 119.98473, floor: 'Ground Floor' },
  { name: 'CTHM Room 103',                   building: 'CTHM', lat: 15.31938, lng: 119.98480, floor: 'Ground Floor' },
  { name: 'CBAPA Faculty Room',              building: 'CTHM', lat: 15.31933, lng: 119.98487, floor: 'Ground Floor' },
  { name: 'CTHM Room 212',                   building: 'CTHM', lat: 15.31975, lng: 119.98421, floor: '2nd Floor' },
  { name: 'CTHM Room 211',                   building: 'CTHM', lat: 15.31972, lng: 119.98426, floor: '2nd Floor' },
  { name: 'CTHM Room 210',                   building: 'CTHM', lat: 15.31969, lng: 119.98431, floor: '2nd Floor' },
  { name: 'CTHM Room 209',                   building: 'CTHM', lat: 15.31966, lng: 119.98436, floor: '2nd Floor' },
  { name: 'CTHM Room 208',                   building: 'CTHM', lat: 15.31963, lng: 119.98441, floor: '2nd Floor' },
  { name: 'CTHM Room 207',                   building: 'CTHM', lat: 15.31960, lng: 119.98446, floor: '2nd Floor' },
  { name: 'CTHM Room 206',                   building: 'CTHM', lat: 15.31954, lng: 119.98456, floor: '2nd Floor' },
  { name: 'CTHM Room 205',                   building: 'CTHM', lat: 15.31949, lng: 119.98462, floor: '2nd Floor' },
  { name: 'CTHM Room 204',                   building: 'CTHM', lat: 15.31946, lng: 119.98468, floor: '2nd Floor' },
  { name: 'CTHM Room 203',                   building: 'CTHM', lat: 15.31941, lng: 119.98474, floor: '2nd Floor' },
  { name: 'CTHM Room 202',                   building: 'CTHM', lat: 15.31936, lng: 119.98480, floor: '2nd Floor' },
  { name: 'CTHM Room 201',                   building: 'CTHM', lat: 15.31933, lng: 119.98486, floor: '2nd Floor' },
  // ── CIT ──
  { name: 'Research and Extension Office', building: 'CIT', lat: 15.31771, lng: 119.98359, floor: 'Ground Floor' },
  { name: 'Electronics Technology',        building: 'CIT', lat: 15.31770, lng: 119.98369, floor: 'Ground Floor' },
  // ── CTE ──
  { name: 'Comfort Room', building: 'CTE', lat: 15.31847, lng: 119.98508, floor: 'Ground Floor' },
  { name: 'CTE 101',      building: 'CTE', lat: 15.31843, lng: 119.98505, floor: 'Ground Floor' },
  { name: 'CTE 102',      building: 'CTE', lat: 15.31839, lng: 119.98502, floor: 'Ground Floor' },
  { name: 'CTE 103',      building: 'CTE', lat: 15.31835, lng: 119.98499, floor: 'Ground Floor' },
  { name: 'CTE 104',      building: 'CTE', lat: 15.31831, lng: 119.98496, floor: 'Ground Floor' },
  { name: 'CTE 105',      building: 'CTE', lat: 15.31827, lng: 119.98493, floor: 'Ground Floor' },
  { name: 'CTE 201',      building: 'CTE', lat: 15.31845, lng: 119.98505, floor: '2nd Floor' },
  { name: 'CTE 202',      building: 'CTE', lat: 15.31841, lng: 119.98502, floor: '2nd Floor' },
  { name: 'CTE 203',      building: 'CTE', lat: 15.31837, lng: 119.98499, floor: '2nd Floor' },
  { name: 'CTE 204',      building: 'CTE', lat: 15.31833, lng: 119.98496, floor: '2nd Floor' },
  { name: 'CTE 205',      building: 'CTE', lat: 15.31829, lng: 119.98493, floor: '2nd Floor' },
  { name: 'CTE 206',      building: 'CTE', lat: 15.31825, lng: 119.98490, floor: '2nd Floor' },
  // ── Annex ──
  { name: 'CASA 101',     building: 'Annex', lat: 15.31914, lng: 119.98467, floor: 'Ground Floor' },
  { name: 'CASA 102',     building: 'Annex', lat: 15.31907, lng: 119.98462, floor: 'Ground Floor' },
  { name: 'CASA 103',     building: 'Annex', lat: 15.31900, lng: 119.98457, floor: 'Ground Floor' },
  { name: 'CASA 104',     building: 'Annex', lat: 15.31893, lng: 119.98452, floor: 'Ground Floor' },
  { name: 'CASAnnex 201', building: 'Annex', lat: 15.31915, lng: 119.98465, floor: '2nd Floor' },
  { name: 'CASAnnex 202', building: 'Annex', lat: 15.31908, lng: 119.98460, floor: '2nd Floor' },
  { name: 'CASAnnex 203', building: 'Annex', lat: 15.31901, lng: 119.98455, floor: '2nd Floor' },
  { name: 'CASAnnex 204', building: 'Annex', lat: 15.31894, lng: 119.98450, floor: '2nd Floor' },
  { name: 'CASAnnex 205', building: 'Annex', lat: 15.31889, lng: 119.98448, floor: '2nd Floor' },
  // ── CAS ──
  { name: 'Faculty Room',                        building: 'CAS', lat: 15.31819, lng: 119.98465, floor: 'Ground Floor' },
  { name: 'Laboratory Repository System',         building: 'CAS', lat: 15.31824, lng: 119.98458, floor: 'Ground Floor' },
  { name: 'CAS 103-Biology/Chemistry Laboratory Room', building: 'CAS', lat: 15.31829, lng: 119.98451, floor: 'Ground Floor' },
  { name: 'CAS 201', building: 'CAS', lat: 15.31819, lng: 119.98463, floor: '2nd Floor' },
  { name: 'CAS 202', building: 'CAS', lat: 15.31824, lng: 119.98456, floor: '2nd Floor' },
  { name: 'CAS 203', building: 'CAS', lat: 15.31829, lng: 119.98449, floor: '2nd Floor' },
  { name: 'CAS 204', building: 'CAS', lat: 15.31834, lng: 119.98442, floor: '2nd Floor' },
  // ── FSMT ──
  { name: 'FSMT Room 11', building: 'FSMT', lat: 15.31805, lng: 119.98375, floor: 'Ground Floor' },
  { name: 'FSMT Room 12', building: 'FSMT', lat: 15.31811, lng: 119.98376, floor: 'Ground Floor' },
  { name: 'FSMT Room 13', building: 'FSMT', lat: 15.31811, lng: 119.98384, floor: 'Ground Floor' },
  { name: 'FSMT Room 14', building: 'FSMT', lat: 15.31810, lng: 119.98392, floor: 'Ground Floor' },
  { name: 'FSMT Room 15', building: 'FSMT', lat: 15.31809, lng: 119.98400, floor: '2nd Floor' },
  { name: 'FSMT Room 26', building: 'FSMT', lat: 15.31808, lng: 119.98408, floor: '2nd Floor' },
  // ── SBEB ──
  { name: 'Accreditation Room',       building: 'SBEB', lat: 15.31867, lng: 119.98455, floor: 'Ground Floor' },
  { name: 'Extension Room',           building: 'SBEB', lat: 15.31867, lng: 119.98468, floor: 'Ground Floor' },
  { name: 'SBEB-AVR Room',            building: 'SBEB', lat: 15.31860, lng: 119.98479, floor: 'Ground Floor' },
  { name: "Dean's Office",            building: 'SBEB', lat: 15.31849, lng: 119.98484, floor: 'Ground Floor' },
  { name: 'SBEB Room 201',            building: 'SBEB', lat: 15.31849, lng: 119.98486, floor: '2nd Floor' },
  { name: 'Educ.Tech Room',           building: 'SBEB', lat: 15.31860, lng: 119.98481, floor: '2nd Floor' },
  { name: 'Speech Lab',               building: 'SBEB', lat: 15.31867, lng: 119.98470, floor: '2nd Floor' },
  { name: 'SBEB Room 202',            building: 'SBEB', lat: 15.31867, lng: 119.98457, floor: '2nd Floor' },
  { name: 'SBEB Room 302',            building: 'SBEB', lat: 15.31867, lng: 119.98459, floor: '3rd Floor' },
  { name: 'SBEB Lab 1 (Physics Lab)', building: 'SBEB', lat: 15.31867, lng: 119.98472, floor: '3rd Floor' },
  { name: 'SBEB Lab 2 (Chem Lab)',    building: 'SBEB', lat: 15.31860, lng: 119.98483, floor: '3rd Floor' },
  { name: 'SBEEB Room 301',           building: 'SBEB', lat: 15.31849, lng: 119.98488, floor: '3rd Floor' },
  // ── Graduate School ──
  { name: "GS Dean's Office",              building: 'Graduate School', lat: 15.31898, lng: 119.98381, floor: 'Ground Floor' },
  { name: 'GE Staff Office',               building: 'Graduate School', lat: 15.31882, lng: 119.98368, floor: 'Ground Floor' },
  { name: 'BS Criminology Faculty Office', building: 'Graduate School', lat: 15.31914, lng: 119.98368, floor: 'Ground Floor' },
  { name: 'Lombroso Room',                 building: 'Graduate School', lat: 15.31918, lng: 119.98362, floor: 'Ground Floor' },
  { name: 'Beccaria Room',                 building: 'Graduate School', lat: 15.31922, lng: 119.98356, floor: 'Ground Floor' },
  // ── SSQAB ──
  { name: 'Accreditation Room',                                                          building: 'SSQAB', lat: 15.31918, lng: 119.98385, floor: '2nd Floor' },
  { name: 'Conference Room',                                                             building: 'SSQAB', lat: 15.31924, lng: 119.98389, floor: '2nd Floor' },
  { name: 'Office of the Director',                                                      building: 'SSQAB', lat: 15.31930, lng: 119.98393, floor: '2nd Floor' },
  { name: 'Office of the Instruction Services',                                          building: 'SSQAB', lat: 15.31936, lng: 119.98397, floor: '2nd Floor' },
  { name: 'Comfort Room',                                                                building: 'SSQAB', lat: 15.31915, lng: 119.98383, floor: '2nd Floor' },
  { name: 'Guidance Counseling Services Office (GSCO) - 308',                           building: 'SSQAB', lat: 15.31936, lng: 119.98395, floor: '3rd Floor' },
  { name: 'Scholarship Services Office (SSO) - 305',                                    building: 'SSQAB', lat: 15.31930, lng: 119.98391, floor: '3rd Floor' },
  { name: "Student Affairs and Services, Director's Office - 304",                      building: 'SSQAB', lat: 15.31924, lng: 119.98387, floor: '3rd Floor' },
  { name: 'Culture and the Arts Developing Office (CADO) - 301',                        building: 'SSQAB', lat: 15.31918, lng: 119.98383, floor: '3rd Floor' },
  { name: 'Student Organization (SO) - 307',                                            building: 'SSQAB', lat: 15.31932, lng: 119.98400, floor: '3rd Floor' },
  { name: 'Student Cunduct and Discipline Office (SCDO) - 306',                         building: 'SSQAB', lat: 15.31926, lng: 119.98396, floor: '3rd Floor' },
  { name: 'GSCO Testing Services Office - Carrier and Job Placement Office (CJPO) - 303', building: 'SSQAB', lat: 15.31920, lng: 119.98392, floor: '3rd Floor' },
  { name: 'Economic Enterprises Development Oficce - Student Publication Office - 302', building: 'SSQAB', lat: 15.31914, lng: 119.98388, floor: '3rd Floor' },
  { name: 'Comfort Room',                                                                building: 'SSQAB', lat: 15.31915, lng: 119.98384, floor: '3rd Floor' },
];

try {
  await pool.query('DELETE FROM rooms');
  for (const r of coords) {
    await pool.query(
      `INSERT INTO rooms (building, name, floor, lat, lng)
      VALUES ($1, $2, $3, $4, $5)`,
      [r.building, r.name, r.floor || '—', r.lat || null, r.lng || null]
    );
  }
  res.json({ ok: true, inserted: coords.length });
} catch (err) {
  res.status(500).json({ ok: false, error: err.message });
}
});

app.listen(port, () => {
  console.log(`Supabase API running on http://localhost:${port}`);
});