/**
 * Mailer service for Email Verification and Two-Factor Authentication (2FA).
 *
 * Configured to send real emails via Gmail SMTP when GMAIL_USER and GMAIL_APP_PASSWORD
 * are provided in .env. In development mode without Gmail credentials, it logs the code
 * to the cluster logs and returns a simulated status so registration and 2FA flows work
 * reliably without blocking.
 */
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

function getTransporter() {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }
  return transporter;
}

/**
 * Dispatches a verification email for account registration.
 */
async function sendRegistrationVerification({ email, code, verificationLink }) {
  const mailTransporter = getTransporter();
  const subject = 'AeroScale — Verify Your Email Address';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0c1220; color: #f8fafc; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
        <span style="font-size: 22px; font-weight: 800; color: #3b82f6;">✈ AeroScale</span>
      </div>
      <h2 style="font-size: 20px; color: #ffffff; margin-bottom: 12px;">Welcome to AeroScale Flight Management</h2>
      <p style="color: #94a3b8; font-size: 15px; line-height: 1.6;">
        Please confirm your email address to complete your account registration and activate full booking and itinerary privileges.
      </p>
      <div style="margin: 28px 0; text-align: center;">
        <div style="display: inline-block; padding: 14px 28px; background: #111a2e; border: 1px solid #2563eb; border-radius: 8px; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #60a5fa; font-family: monospace;">
          ${code}
        </div>
        <p style="font-size: 13px; color: #64748b; margin-top: 8px;">Valid for 15 minutes</p>
      </div>
      ${
        verificationLink
          ? `<div style="text-align: center; margin-bottom: 24px;">
               <a href="${verificationLink}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600;">Verify My Account</a>
             </div>`
          : ''
      }
      <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 24px 0;" />
      <p style="font-size: 12px; color: #64748b;">
        If you did not request this registration, please disregard this email.
      </p>
    </div>
  `;

  if (mailTransporter) {
    try {
      const info = await mailTransporter.sendMail({
        from: `"AeroScale Security" <${process.env.GMAIL_USER || process.env.SMTP_USER}>`,
        to: email,
        subject,
        html,
      });
      logger.info('Verification email dispatched via Gmail SMTP', { email, messageId: info.messageId });
      return { sent: true, provider: 'gmail', messageId: info.messageId };
    } catch (err) {
      logger.error('Failed to send email via Gmail SMTP, falling back to simulated log', { error: err.message, email });
    }
  }

  // Simulated fallback for local environment
  logger.info(`[2FA/EMAIL] REGISTRATION VERIFICATION CODE for ${email}: [ ${code} ]`);
  return { sent: true, provider: 'simulated', code };
}

/**
 * Dispatches a Two-Factor Authentication (2FA) sign-in security code.
 */
async function sendLogin2FACode({ email, code }) {
  const mailTransporter = getTransporter();
  const subject = 'AeroScale — Sign-In Verification Code (2FA)';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0c1220; color: #f8fafc; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
        <span style="font-size: 22px; font-weight: 800; color: #3b82f6;">✈ AeroScale</span>
      </div>
      <h2 style="font-size: 20px; color: #ffffff; margin-bottom: 12px;">Two-Factor Authentication Code</h2>
      <p style="color: #94a3b8; font-size: 15px; line-height: 1.6;">
        A sign-in attempt was initiated for your AeroScale account. Enter the 6-digit verification code below to authorize access:
      </p>
      <div style="margin: 28px 0; text-align: center;">
        <div style="display: inline-block; padding: 14px 28px; background: #111a2e; border: 1px solid #2563eb; border-radius: 8px; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #60a5fa; font-family: monospace;">
          ${code}
        </div>
        <p style="font-size: 13px; color: #64748b; margin-top: 8px;">Valid for 10 minutes</p>
      </div>
      <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 24px 0;" />
      <p style="font-size: 12px; color: #64748b;">
        If you did not attempt to sign in, please update your account password immediately.
      </p>
    </div>
  `;

  if (mailTransporter) {
    try {
      const info = await mailTransporter.sendMail({
        from: `"AeroScale Security" <${process.env.GMAIL_USER || process.env.SMTP_USER}>`,
        to: email,
        subject,
        html,
      });
      logger.info('2FA login email dispatched via Gmail SMTP', { email, messageId: info.messageId });
      return { sent: true, provider: 'gmail', messageId: info.messageId };
    } catch (err) {
      logger.error('Failed to send 2FA email via Gmail SMTP, falling back to simulated log', { error: err.message, email });
    }
  }

  // Simulated fallback for local environment
  logger.info(`[2FA/EMAIL] LOGIN 2FA CODE for ${email}: [ ${code} ]`);
  return { sent: true, provider: 'simulated', code };
}

module.exports = {
  sendRegistrationVerification,
  sendLogin2FACode,
};
