import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import {
  AUTH_DIR,
  ENC_FILE,
  getOrCreateKeyHex,
  encryptAuthFolder,
  decryptAuthFolder,
} from './session-crypto.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function normalizeName(str) {
  if (!str) return '';
  return str
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getNtpOffsetMs(host = 'time.google.com', timeoutMs = 2500) {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;

    let doneFlag = false;
    const finish = (val) => {
      if (doneFlag) return;
      doneFlag = true;
      try {
        client.close();
      } catch (_) {}
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const t0 = Date.now();

    client.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    client.on('message', (msg) => {
      const t3 = Date.now();
      clearTimeout(timer);
      if (msg.length < 48) return finish(null);
      const secsSince1900 = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      const ntpEpochOffset = 2208988800;
      const serverMs =
        (secsSince1900 - ntpEpochOffset) * 1000 +
        Math.round((fraction * 1000) / 0x100000000);
      const rtt = t3 - t0;
      finish(serverMs + Math.round(rtt / 2) - t3);
    });

    client.send(packet, 0, 48, 123, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}

async function syncClockOffset() {
  for (const host of ['time.google.com', 'time.cloudflare.com', 'time.windows.com']) {
    const offset = await getNtpOffsetMs(host);
    if (offset !== null && Math.abs(offset) < 600000) {
      log(`Atomic NTP sync (${host}): offset = ${offset >= 0 ? '+' : ''}${offset} ms`);
      return offset;
    }
  }
  log('NTP UDP blocked or unavailable; using system clock (offset = 0 ms).');
  return 0;
}

/**
 * Computes today's date string (YYYY-MM-DD) and exact UTC epoch ms for
 * targetHour24:targetMinute:targetSecond.sendOffsetMs in UTC+timezoneOffsetHours.
 */
function computeTargetTime(trueNowMs, cfg) {
  const tzOffsetMs = (cfg.timezoneOffsetHours ?? 3) * 3600 * 1000;
  const localShifted = new Date(trueNowMs + tzOffsetMs);

  const year = localShifted.getUTCFullYear();
  const month = localShifted.getUTCMonth();
  const day = localShifted.getUTCDate();
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const targetUtcMs =
    Date.UTC(
      year,
      month,
      day,
      cfg.targetHour24 ?? 13,
      cfg.targetMinute ?? 0,
      cfg.targetSecond ?? 0,
      cfg.sendOffsetMs ?? 50
    ) - tzOffsetMs;

  return { dateStr, targetUtcMs };
}

function formatLocalClock(trueMs, tzOffsetHours = 3) {
  const d = new Date(trueMs + tzOffsetHours * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function waitUntilExact(targetTrueMs, offsetMs) {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = targetTrueMs - (Date.now() + offsetMs);
      if (remaining <= 0) return resolve();
      if (remaining > 2000) {
        setTimeout(tick, remaining - 1000);
      } else if (remaining > 40) {
        setTimeout(tick, 8);
      } else {
        setImmediate(tick);
      }
    };
    tick();
  });
}

async function findGroup(sock, cfg) {
  const groupsObj = await sock.groupFetchAllParticipating();
  const groups = Object.values(groupsObj || {});

  if (cfg.groupId && groupsObj[cfg.groupId]) {
    return { target: groupsObj[cfg.groupId], allGroups: groups };
  }

  const targetNorm = normalizeName(cfg.groupName);

  let match = groups.find((g) => normalizeName(g.subject) === targetNorm);
  if (match) return { target: match, allGroups: groups };

  match = groups.find((g) => normalizeName(g.subject).includes(targetNorm));
  if (match) return { target: match, allGroups: groups };

  const tokens = targetNorm.split(' ').filter(Boolean);
  if (tokens.length > 0) {
    match = groups.find((g) => {
      const gNorm = normalizeName(g.subject);
      return tokens.every((t) => gNorm.includes(t));
    });
    if (match) return { target: match, allGroups: groups };
  }

  return { target: null, allGroups: groups };
}

function bareJid(jid) {
  if (!jid) return '';
  return jid.replace(/:\d+@/, '@');
}

async function run() {
  const args = new Set(process.argv.slice(2));
  const envMode = (process.env.BOT_MODE || '').trim().toLowerCase();
  const isSetup = args.has('--setup') || envMode === 'setup';
  const isDryRun = args.has('--dry-run') || envMode === 'dry-run';
  const isTestMe = args.has('--test-me') || envMode === 'test-me';
  const modeName = isSetup ? 'SETUP' : isDryRun ? 'DRY-RUN' : isTestMe ? 'TEST-ME' : 'LIVE';

  const config = loadConfig();
  log(`Starting Cloud WhatsApp NHC Bot | mode=${modeName}`);

  const keyHex = getOrCreateKeyHex(isSetup);

  // In non-setup modes, decrypt session.enc into auth_info if needed
  if (!isSetup) {
    if (fs.existsSync(ENC_FILE)) {
      const count = decryptAuthFolder(keyHex);
      log(`Decrypted ${count} session files from session.enc`);
    } else if (!fs.existsSync(AUTH_DIR)) {
      throw new Error('Neither session.enc nor auth_info/ exists! Run `npm run setup` first.');
    }
  }

  const offsetMs = await syncClockOffset();
  const { dateStr } = computeTargetTime(Date.now() + offsetMs, config);

  // Deduplication safety: never double-send on the same day in LIVE mode
  if (modeName === 'LIVE' && config.lastSentDate === dateStr) {
    log(`Already sent "${config.messageText}" today (${dateStr}). Exiting cleanly without duplicate send.`);
    process.exit(0);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log(`Using WhatsApp Web protocol v${version.join('.')}`);

  let activeSock = null;
  let taskRunning = false;
  let completed = false;

  async function persistAndExit(code = 0) {
    if (completed) return;
    completed = true;
    try {
      const n = encryptAuthFolder(keyHex);
      log(`Saved & encrypted ${n} updated session files -> session.enc`);
    } catch (e) {
      log(`Warning while encrypting session: ${e.message}`);
    }
    try {
      activeSock?.end(undefined);
    } catch (_) {}
    process.exit(code);
  }

  function startSocket() {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    activeSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (!isSetup) {
          log('ERROR: Session expired or invalid (QR requested in non-setup mode). Please re-run `npm run setup`.');
          process.exit(1);
        }
        console.log('\n=======================================================');
        console.log(' امسح كود الـ QR التالي من واتساب في موبايلك:');
        console.log(' (الأجهزة المرتبطة -> ربط جهاز)');
        console.log('=======================================================\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        if (completed) return;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        log(`Connection closed (status=${statusCode}).`);
        if (statusCode === DisconnectReason.loggedOut) {
          log('ERROR: Device was logged out from WhatsApp. Re-run `npm run setup`.');
          process.exit(1);
        }
        // Reconnect automatically (e.g., code 515 restartRequired right after QR scan)
        log('Reconnecting socket...');
        setTimeout(startSocket, 800);
      }

      if (connection === 'open' && !taskRunning && !completed) {
        taskRunning = true;
        try {
          await onConnected(sock);
        } catch (err) {
          log(`Runtime error: ${err.stack || err.message}`);
          await persistAndExit(1);
        }
      }
    });
  }

  async function onConnected(sock) {
    log(`Connected to WhatsApp as: ${sock.user?.id || 'unknown'}`);

    const { target, allGroups } = await findGroup(sock, config);
    if (!target) {
      log(`ERROR: Could not find group matching "${config.groupName}".`);
      log(`Found ${allGroups.length} groups on your account:`);
      allGroups.slice(0, 30).forEach((g, i) => {
        console.log(`  [${i + 1}] "${g.subject}" -> ${g.id}`);
      });
      await persistAndExit(1);
      return;
    }

    log(`Matched Group: "${target.subject}" (${target.id})`);
    if (config.groupId !== target.id) {
      config.groupId = target.id;
      saveConfig(config);
      log(`Saved exact groupId to config.json: ${config.groupId}`);
    }

    if (isSetup) {
      log('Waiting 4 seconds for initial Signal keys sync...');
      await new Promise((r) => setTimeout(r, 4000));
      const n = encryptAuthFolder(keyHex);
      console.log('\n====================================================================');
      console.log(' تم ربط الواتساب وتشفير الجلسة بنجاح! (session.enc جاهز)');
      console.log(` الجروب المستهدف: ${target.subject} (${target.id})`);
      console.log(` عدد ملفات الجلسة المشفرة: ${n}`);
      console.log('--------------------------------------------------------------------');
      console.log(' انسخ مفتاح التشفير السري ده وحطه في GitHub Secrets باسم SESSION_KEY:');
      console.log(`\n${keyHex}\n`);
      console.log(' (محفوظ أيضاً على جهازك في ملف session-key.txt)');
      console.log('====================================================================\n');
      completed = true;
      try {
        sock.end(undefined);
      } catch (_) {}
      process.exit(0);
    }

    if (isDryRun) {
      const nowTrue = Date.now() + offsetMs;
      const { targetUtcMs } = computeTargetTime(nowTrue, config);
      log(
        `DRY-RUN OK! Local Time (UTC+${config.timezoneOffsetHours}): ${formatLocalClock(
          nowTrue,
          config.timezoneOffsetHours
        )} | Target: ${formatLocalClock(targetUtcMs, config.timezoneOffsetHours)}`
      );
      await new Promise((r) => setTimeout(r, 2000));
      await persistAndExit(0);
      return;
    }

    if (isTestMe) {
      const selfJid = bareJid(sock.user.id);
      log(`Sending test message "${config.messageText}" to your own chat (${selfJid})...`);
      await sock.sendMessage(selfJid, { text: `${config.messageText} (تجربة سحابية ناجحة ✅)` });
      log('Self-test message delivered! Waiting 3s before saving session...');
      await new Promise((r) => setTimeout(r, 3000));
      await persistAndExit(0);
      return;
    }

    // LIVE MODE: Wait until exact 13:00:00.050 (UTC+3) and send "ناجى"
    const nowTrue = Date.now() + offsetMs;
    const { dateStr: todayStr, targetUtcMs } = computeTargetTime(nowTrue, config);
    const waitMs = targetUtcMs - nowTrue;

    if (waitMs < -5 * 60 * 1000) {
      log(
        `Current time (${formatLocalClock(nowTrue, config.timezoneOffsetHours)}) is >5 min past target (${formatLocalClock(
          targetUtcMs,
          config.timezoneOffsetHours
        )}). Exiting safely without sending.`
      );
      await persistAndExit(0);
      return;
    }

    if (waitMs > 15000) {
      log(
        `Waiting ${((waitMs - 12000) / 1000).toFixed(1)}s until warm-up before ${formatLocalClock(
          targetUtcMs,
          config.timezoneOffsetHours
        )}...`
      );
      await waitUntilExact(targetUtcMs - 12000, offsetMs);
      // Warm up connection & refresh group metadata 12s before 1:00 PM
      try {
        await activeSock.groupMetadata(config.groupId);
        log('Pre-1:00 PM socket & group metadata warm-up complete.');
      } catch (_) {}
    }

    if (targetUtcMs > Date.now() + offsetMs) {
      log(`Final precision countdown to ${formatLocalClock(targetUtcMs, config.timezoneOffsetHours)}...`);
      await waitUntilExact(targetUtcMs, offsetMs);
    }

    // Send immediately at 13:00:00.050; if group is admin-locked, fire the instant it unlocks
    let sent = false;
    const deadline = Date.now() + (config.maxWaitUnlockMinutes || 5) * 60 * 1000;

    const attemptSend = async () => {
      if (sent) return true;
      try {
        const fireTrue = Date.now() + offsetMs;
        await activeSock.sendMessage(config.groupId, { text: config.messageText });
        sent = true;
        log(
          `SUCCESS! Sent "${config.messageText}" to "${target.subject}" at exact time ${formatLocalClock(
            fireTrue,
            config.timezoneOffsetHours
          )}!`
        );
        config.lastSentDate = todayStr;
        saveConfig(config);
        return true;
      } catch (err) {
        log(`Send attempt failed (retrying): ${err.message}`);
        return false;
      }
    };

    activeSock.ev.on('groups.update', async (updates) => {
      for (const u of updates) {
        if (u.id === config.groupId && u.announce === false && !sent) {
          log('Detected group UNLOCK event! Sending immediately...');
          if (await attemptSend()) {
            await new Promise((r) => setTimeout(r, 4000));
            await persistAndExit(0);
          }
        }
      }
    });

    while (!sent && Date.now() < deadline) {
      let lockedForMe = false;
      try {
        const meta = await activeSock.groupMetadata(config.groupId);
        if (meta?.announce) {
          const meBare = bareJid(activeSock.user?.id);
          const meLid = bareJid(activeSock.user?.lid);
          const meP = (meta.participants || []).find((p) => {
            const pid = bareJid(p.id);
            return pid === meBare || (meLid && pid === meLid);
          });
          const isAdmin = Boolean(meP?.admin === 'admin' || meP?.admin === 'superadmin');
          if (!isAdmin) lockedForMe = true;
        }
      } catch (_) {}

      if (!lockedForMe) {
        if (await attemptSend()) break;
      } else {
        log('Group is still Admins-Only locked; checking again in 250ms...');
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    if (!sent) {
      log('ERROR: Could not send message within unlock wait window.');
      await persistAndExit(1);
      return;
    }

    log('Waiting 4 seconds to guarantee WhatsApp server delivery & ratchet sync...');
    await new Promise((r) => setTimeout(r, 4000));
    await persistAndExit(0);
  }

  startSocket();
}

run().catch((err) => {
  log(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
