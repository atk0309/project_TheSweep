// Transactional email via Resend, with a console fallback for local/dev.
import { Resend } from 'resend';
import { config } from './config.js';

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

function logDevelopmentLink(logger, runtimeConfig, email, verifyUrl, { invite }) {
  if (runtimeConfig.isProd) return;
  logger.log(`\n[mailer:DEV]${invite ? ' (invite)' : ''} → ${email}\n[mailer:DEV] ${verifyUrl}\n`);
}

export function createMagicLinkSender({
  mailClient = resend,
  runtimeConfig = config,
  logger = console,
} = {}) {
  return async function send(email, verifyUrl, { invite = false } = {}) {
    const subject = invite ? "You're in — claim your spot · The Sweep" : 'Your magic link · The Sweep';
    const text = invite
      ? `You've been invited to The Sweep — the 2026 world football sweepstake.\n\nTap to claim your spot:\n${verifyUrl}\n\nThis link expires in 15 minutes.`
      : `Tap to sign in to The Sweep:\n${verifyUrl}\n\nThis link expires in 15 minutes.`;
    if (!mailClient) {
      if (runtimeConfig.isProd) {
        // Production config validation should make this unreachable. Keep the
        // defense here so a future caller cannot turn missing mail into a leak.
        logger.error('[mailer] delivery unavailable');
        return { ok: false, error: 'delivery_unavailable' };
      }
      logDevelopmentLink(logger, runtimeConfig, email, verifyUrl, { invite });
      return { ok: true, dev: true };
    }
    try {
      const { error } = await mailClient.emails.send({
        from: runtimeConfig.emailFrom,
        to: email,
        subject,
        html: magicLinkHtml(verifyUrl, { invite }),
        text,
      });
      if (error) {
        // Provider errors may echo recipient data. Production gets a deliberately
        // generic log line; local development keeps the bearer link available.
        if (runtimeConfig.isProd) logger.error('[mailer] Resend delivery failed');
        else {
          logger.error('[mailer] Resend delivery failed:', error);
          logDevelopmentLink(logger, runtimeConfig, email, verifyUrl, { invite });
        }
        return { ok: false, error: 'delivery_failed' };
      }
      return { ok: true };
    } catch (e) {
      if (runtimeConfig.isProd) logger.error('[mailer] Resend delivery threw');
      else {
        logger.error('[mailer] Resend delivery threw:', e.message);
        logDevelopmentLink(logger, runtimeConfig, email, verifyUrl, { invite });
      }
      return { ok: false, error: 'delivery_failed' };
    }
  };
}

export const sendMagicLink = createMagicLinkSender();

function magicLinkHtml(url, { invite = false } = {}) {
  const lead = invite
    ? "You've been invited to The Sweep. Tap below to claim your spot — no password, ever. This link works once and expires in 15 minutes."
    : 'Tap below to jump in — no password, ever. This link works once and expires in 15 minutes.';
  const cta = invite ? 'Claim your spot →' : 'Sign in to The Sweep →';
  return `<!DOCTYPE html><html><body style="margin:0;background:#05100a;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:460px;margin:0 auto;padding:40px 28px;color:#eafff0;">
    <div style="font-size:13px;letter-spacing:4px;color:#7fbf98;">WORLD FOOTBALL 2026</div>
    <div style="font-size:42px;font-weight:800;line-height:.9;margin:4px 0 18px;">THE SWEEP<span style="color:#16ff7a;">.</span></div>
    <p style="font-size:16px;color:#bfe9cd;line-height:1.4;">${lead}</p>
    <a href="${url}" style="display:inline-block;margin:18px 0;padding:16px 28px;border-radius:14px;background:#16ff7a;color:#022a14;font-weight:800;font-size:18px;text-decoration:none;">${cta}</a>
    <p style="font-size:12px;color:#5f7768;">If you didn't request this, ignore this email.</p>
  </div></body></html>`;
}
