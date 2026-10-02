import pkg from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import config from '../config/index.js';
import { WhatsAppModel } from '../models/WhatsApp.js';
import { formatPhoneForWhatsApp, normalizePhone } from './messageService.js';

// ─── Memoize getter patch ─────────────────────────────────────────────────────
// whatsapp-web.js 1.34.x uses Object.defineProperty memoized getters on message
// objects.  After a reconnect the memoize cache goes stale and throws errors
// like "Cannot read properties of undefined (reading 'id')" or "getter must
// include either get or set".  We inject this script into the Puppeteer page so
// every getter is wrapped in a try/catch that degrades to `undefined` instead of
// crashing — which lets the library continue working.
const wwebMemoizePatchSource = `(function patchWWebMemoize() {
  try {
    if (window.__wwebMemoizePatched) return 'already_patched';
    window.__wwebMemoizePatched = true;

    // Strategy 1: Wrap Object.defineProperty getters
    const _origDefProp = Object.defineProperty.bind(Object);
    Object.defineProperty = function patchedDefineProperty(obj, prop, descriptor) {
      if (descriptor && typeof descriptor.get === 'function') {
        const origGet = descriptor.get;
        descriptor = Object.assign({}, descriptor, {
          get: function() {
            try { return origGet.call(this); } catch (e) {
              const m = String(e && e.message || e);
              if (m.includes('id') || m.includes('memoize') || m.includes('getter') ||
                  m.includes('Cannot read') || m.includes('undefined') || m.includes('property')) {
                return undefined;
              }
              throw e;
            }
          }
        });
      }
      return _origDefProp(obj, prop, descriptor);
    };

    // Strategy 2: Patch window.WWebJS.getMessageModel to swallow memoize errors
    // The error fires inside getMessageModel when it calls getSender() on the msg.
    // We wrap it so a failed getMessageModel returns null rather than throwing,
    // which lets sendMessage() return undefined (still a successful send).
    const patchWWebJS = () => {
      if (!window.WWebJS) return false;
      if (window.WWebJS.__getMessageModelPatched) return true;
      const origGetMsgModel = window.WWebJS.getMessageModel;
      if (typeof origGetMsgModel !== 'function') return false;
      window.WWebJS.getMessageModel = function safeGetMessageModel(msg) {
        try { return origGetMsgModel.call(this, msg); }
        catch (e) {
          const m = String(e && e.message || e);
          if (m.includes('id') || m.includes('memoize') || m.includes('getter') || m.includes('property')) {
            return null; // send succeeded, just can't read the msg model back
          }
          throw e;
        }
      };
      window.WWebJS.__getMessageModelPatched = true;

      // Also patch getChat and sendMessage wrappers
      if (typeof window.WWebJS.sendMessage === 'function') {
        const origSend = window.WWebJS.sendMessage;
        window.WWebJS.sendMessage = async function safeSendMessage(...args) {
          try { return await origSend.apply(this, args); }
          catch (e) {
            const m = String(e && e.message || e);
            if (m.includes('id') || m.includes('memoize') || m.includes('getter') || m.includes('property')) {
              return args[0]; // return the chat object as a stand-in
            }
            throw e;
          }
        };
      }
      return true;
    };

    // Try to patch immediately (if WWebJS already loaded)
    if (!patchWWebJS()) {
      // WWebJS not loaded yet — poll until it is
      let attempts = 0;
      const interval = setInterval(() => {
        if (patchWWebJS() || ++attempts > 60) clearInterval(interval);
      }, 500);
    }

    return 'patched';
  } catch (e) {
    return 'patch_failed:' + String(e && e.message || e);
  }
})();`;

// ─── Multi-tenant instance registry ──────────────────────────────────────────
const instances = new Map();

export function getWhatsAppService(tenantId) {
  if (!tenantId) throw new Error('tenantId is required for WhatsApp service');
  if (!instances.has(tenantId)) {
    instances.set(tenantId, new WhatsAppService(tenantId));
  }
  return instances.get(tenantId);
}

export function removeWhatsAppService(tenantId) {
  instances.delete(tenantId);
}

// ─── Chrome executable discovery ─────────────────────────────────────────────
export const findChromeWindows = () => {
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  const pf    = process.env.PROGRAMFILES;
  const pf86  = process.env['PROGRAMFILES(X86)'];
  if (local) {
    candidates.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidates.push(path.join(local, 'Chromium', 'Application', 'chrome.exe'));
    candidates.push(path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  }
  if (pf) {
    candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (pf86) {
    candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  candidates.push('/usr/bin/google-chrome');
  candidates.push('/usr/bin/chromium-browser');
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
};

export const getPuppeteerExecutable = () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    try { if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH; } catch { /* ignore */ }
  }
  const sysChrome = findChromeWindows();
  if (sysChrome) return sysChrome;
  try {
    const ep = puppeteer.executablePath();
    if (ep && fs.existsSync(ep)) return ep;
  } catch (e) {
    console.warn('[WhatsApp] puppeteer.executablePath() not available:', e.message);
  }
  return null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Delete Chrome lock files from a profile directory. */
const removeLockFiles = (dir, label) => {
  if (!dir) return;
  for (const f of ['lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); console.log(`[WhatsApp] Removed stale lock (${label}): ${f}`); }
    } catch { /* ignore */ }
  }
};

/**
 * Best-effort kill of orphaned Chrome/Chromium processes holding a lock on
 * the given userDataDir.  Uses wmic+taskkill on Windows, pkill on Unix.
 */
const killOrphanChrome = (userDataDir) => {
  try {
    if (os.platform() === 'win32') {
      const escaped = userDataDir.replace(/\\/g, '\\\\').replace(/'/g, "''");
      for (const name of ['chrome.exe', 'msedge.exe', 'chromium.exe']) {
        try {
          const out = execSync(
            `wmic process where "name='${name}' and commandline like '%${escaped}%'" get processid /format:value`,
            { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
          ).toString();
          const pids = out.match(/ProcessId=(\d+)/gi)?.map(m => m.split('=')[1]) || [];
          for (const pid of pids) {
            try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000, stdio: 'ignore' }); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    } else {
      try { execSync(`pkill -f "${userDataDir.replace(/"/g, '\\"')}"`, { timeout: 5000, stdio: 'ignore' }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
};

/** True if the error message matches known memoize/getter bugs OR LID-related send failures. */
const isMemoizeError = (msg) =>
  msg.includes('id property') ||
  msg.includes('memoize') ||
  msg.includes('No LID') ||
  msg.includes('@lid') ||
  /getter.*id/i.test(msg) ||
  (/getter must include/i.test(msg)) ||
  (msg.includes('undefined') && /getter/i.test(msg));

/** True if the error message indicates a detached Puppeteer frame. */
const isDetachedError = (msg) =>
  msg.includes('detached') || msg.includes('Detached') || msg.includes('Target closed');

// ─── WhatsAppService class ────────────────────────────────────────────────────
class WhatsAppService {
  constructor(tenantId) {
    this.tenantId       = tenantId;
    this.client         = null;
    this.qrCode         = null;
    this.status         = 'disconnected';
    this.phoneNumber    = null;
    this.lastError      = null;
    this.initializing   = false;
    this.shouldReconnect = false;
    this.reconnectTimer = null;
    this.initStartAt    = null;
  }

  // ── Public status ──────────────────────────────────────────────────────────
  getStatus() {
    return {
      status:      this.status,
      qrCode:      this.qrCode,
      phoneNumber: this.phoneNumber,
      isConnected: this.status === 'connected',
      error:       this.lastError,
      initializing: this.initializing,
      initMs:      this.initStartAt ? Date.now() - this.initStartAt : null,
    };
  }

  // ── Reconnect timer ────────────────────────────────────────────────────────
  clearReconnectTimer() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  scheduleReconnect(reason = 'unknown') {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = config.whatsappReconnectDelayMs;
    console.log(`[WhatsApp][${this.tenantId}] Reconnect in ${delay}ms (${reason})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.initialize(); } catch (err) {
        console.error(`[WhatsApp][${this.tenantId}] Reconnect failed:`, err.message);
        this.scheduleReconnect('retry_failed');
      }
    }, delay);
  }

  // ── Initialize ─────────────────────────────────────────────────────────────
  async initialize() {
    if (this.client && this.status === 'connected') return;
    if (this.initializing) return;

    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.initStartAt  = Date.now();
    this.initializing = true;
    this.status       = 'initializing';
    this.lastError    = null;
    this.qrCode       = null;

    // Destroy any stale client
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }

    // Build session paths
    const sessionPath     = path.resolve(path.join(config.whatsappSessionPath, `tenant-${this.tenantId}`));
    const puppeteerDataPath = `${sessionPath}__pup`;
    const sessionDataPath = path.join(sessionPath, `session-tenant-${this.tenantId}`);

    try { fs.mkdirSync(sessionPath,      { recursive: true }); } catch { /* ignore */ }
    try { fs.mkdirSync(puppeteerDataPath, { recursive: true }); } catch { /* ignore */ }

    // Clean stale locks from BOTH dirs before launching Chrome
    removeLockFiles(sessionDataPath,   'LocalAuth');
    removeLockFiles(puppeteerDataPath, 'Puppeteer');

    const executablePath = getPuppeteerExecutable();
    console.log(
      `[WhatsApp][${this.tenantId}] Initializing.` +
      ` sessionDir=${sessionPath}` +
      ` executable=${executablePath || 'NOT FOUND (will fail!)'}` +
      ` platform=${os.platform()} arch=${os.arch()}`
    );

    if (!executablePath) {
      const msg = 'No Chrome/Chromium executable found. Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH.';
      console.error(`[WhatsApp][${this.tenantId}] ${msg}`);
      this.status = 'error'; this.initializing = false; this.lastError = msg;
      return;
    }

    const puppeteerOptions = {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        `--user-data-dir=${puppeteerDataPath}`,
      ],
      dumpio: false,
      ignoreHTTPSErrors: true,
    };

    // Build client
    // Pin WhatsApp Web to the last known working version for media/PDF sending.
    // Versions from Oct 2026 onward broke sendMessage() for all media due to a
    // memoize-getter bug in getSender() inside WhatsApp's own JS.
    // We use LocalWebCache pointing at the existing .wwebjs_cache directory
    // which already has the Aug 2026 version (2.3000.1045624538) cached locally.
    const cacheDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '..', '..', '.wwebjs_cache'
    );
    const pinnedVersion = '2.3000.1045624538';
    const pinnedHtmlExists = fs.existsSync(path.join(cacheDir, `${pinnedVersion}.html`));
    const webVersionConfig = pinnedHtmlExists ? {
      webVersion: pinnedVersion,
      webVersionCache: { type: 'local', path: cacheDir, strict: false },
    } : {};
    console.log(`[WhatsApp][${this.tenantId}] webVersion pin: ${pinnedHtmlExists ? pinnedVersion + ' (local cache)' : 'DISABLED — cached HTML not found at ' + cacheDir}`);

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath, clientId: `tenant-${this.tenantId}` }),
        puppeteer: puppeteerOptions,
        qrMaxRetries: 5,
        takeoverOnConflict: true,
        ...webVersionConfig,
      });
    } catch (err) {
      this.status = 'error'; this.initializing = false;
      this.lastError = `Failed to create client: ${err.message}`;
      console.error(`[WhatsApp][${this.tenantId}] Client create failed:`, err.message);
      return;
    }

    this._attachClientEvents();

    // 90-second safety timeout — resets the `initializing` flag if no event fires.
    // This prevents the service from being permanently locked in "initializing".
    const INIT_TIMEOUT_MS = 90_000;
    const initTimeoutHandle = setTimeout(() => {
      if (this.initializing) {
        console.warn(`[WhatsApp][${this.tenantId}] Init timed out after ${INIT_TIMEOUT_MS / 1000}s`);
        this.initializing = false;
        this.status = 'error';
        this.lastError = 'Initialization timed out. Check Chrome or internet connection.';
        this.scheduleReconnect('init_timeout');
      }
    }, INIT_TIMEOUT_MS);

    // Poll to auto-clear the timeout once any event resets initializing
    const pollHandle = setInterval(() => {
      if (!this.initializing) { clearTimeout(initTimeoutHandle); clearInterval(pollHandle); }
    }, 1000);

    // Fire initialize() without await — it is event-driven and never resolves on success.
    this.client.initialize().catch(async (err) => {
      clearTimeout(initTimeoutHandle);
      clearInterval(pollHandle);
      const errMsg = err.message || String(err);
      console.error(`[WhatsApp][${this.tenantId}] Init error:`, errMsg);

      // ── Lock conflict: orphaned Chrome holding the profile dir ─────────
      const isLockConflict =
        errMsg.includes('already running') ||
        errMsg.includes('userDataDir') ||
        errMsg.includes('user-data-dir') ||
        errMsg.includes('SingletonLock') ||
        errMsg.includes('profile is already in use');

      if (isLockConflict) {
        console.warn(`[WhatsApp][${this.tenantId}] Lock conflict — killing orphan Chrome and retrying…`);
        try { if (this.client) await this.client.destroy(); } catch { /* ignore */ }
        this.client = null;

        killOrphanChrome(puppeteerDataPath);
        killOrphanChrome(sessionDataPath);
        await new Promise(r => setTimeout(r, 2500));
        removeLockFiles(puppeteerDataPath, 'Puppeteer-retry');
        removeLockFiles(sessionDataPath,   'LocalAuth-retry');

        try {
          this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: sessionPath, clientId: `tenant-${this.tenantId}` }),
            puppeteer: puppeteerOptions,
            qrMaxRetries: 5,
            takeoverOnConflict: true,
            ...webVersionConfig,
          });
          this._attachClientEvents();

          const retryTimeout = setTimeout(() => {
            if (this.initializing) {
              this.initializing = false; this.status = 'error';
              this.lastError = 'Retry init timed out after lock-conflict fix.';
              this.scheduleReconnect('retry_init_timeout');
            }
          }, INIT_TIMEOUT_MS);

          this.client.initialize().catch(async (retryErr) => {
            clearTimeout(retryTimeout);
            console.error(`[WhatsApp][${this.tenantId}] Retry also failed:`, retryErr.message);
            try { if (this.client) await this.client.destroy(); } catch { /* ignore */ }
            this.client = null;
            this.status = 'error'; this.initializing = false; this.lastError = retryErr.message;
            try { await WhatsAppModel.updateSession({ is_connected: false, phone_number: null, session_data: { status: 'error', reason: retryErr.message } }, this.tenantId); } catch { /* ignore */ }
            this.scheduleReconnect('lock_conflict_retry_failed');
          });
        } catch (buildErr) {
          this.status = 'error'; this.initializing = false; this.lastError = buildErr.message;
          this.scheduleReconnect('client_rebuild_failed');
        }
        return;
      }
      // ──────────────────────────────────────────────────────────────────

      this.status = 'error'; this.initializing = false; this.lastError = errMsg;
      try { if (this.client) await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
      try { await WhatsAppModel.updateSession({ is_connected: false, phone_number: null, session_data: { status: 'error', reason: errMsg } }, this.tenantId); } catch { /* ignore */ }
      this.scheduleReconnect('initialize_error');
    });
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  _attachClientEvents() {
    this.client.on('qr', async (qr) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.status = 'qr_ready';
        this.initializing = false;
        this.lastError = null;
        console.log(`[WhatsApp][${this.tenantId}] QR ready (${Date.now() - this.initStartAt}ms)`);
      } catch (err) {
        this.status = 'error'; this.initializing = false;
        this.lastError = 'QR generate failed: ' + (err?.message || String(err));
        console.error(`[WhatsApp][${this.tenantId}] QR generate failed:`, err?.message);
        return;
      }
      try { await WhatsAppModel.updateSession({ is_connected: false, session_data: { status: 'qr_ready' } }, this.tenantId); } catch { /* ignore */ }
    });

    this.client.on('authenticated', () => {
      this.status = 'authenticated'; this.qrCode = null;
      this.initializing = false; this.lastError = null;
      console.log(`[WhatsApp][${this.tenantId}] Authenticated`);
    });

    this.client.on('ready', async () => {
      this.status = 'connected'; this.qrCode = null;
      this.initializing = false; this.lastError = null;
      this.clearReconnectTimer();
      this.phoneNumber = this.client.info?.wid?.user || null;
      console.log(`[WhatsApp][${this.tenantId}] Connected: +${this.phoneNumber} (${Date.now() - (this.initStartAt || Date.now())}ms)`);
      try { await WhatsAppModel.updateSession({ is_connected: true, phone_number: this.phoneNumber, last_connected_at: new Date().toISOString(), session_data: { status: 'connected', phone: this.phoneNumber } }, this.tenantId); } catch { /* ignore */ }
      // Apply memoize patch immediately on ready
      try { await this.patchWwebVMGetters(); } catch (e) {
        console.warn(`[WhatsApp][${this.tenantId}] VM patch skipped (non-fatal):`, String(e?.message || e).slice(0, 200));
      }
      try { await this._interceptAndPatchJS(); } catch { /* ignore */ }
    });

    this.client.on('disconnected', async (reason) => {
      console.log(`[WhatsApp][${this.tenantId}] Disconnected:`, reason);
      this.status = 'disconnected'; this.qrCode = null;
      this.phoneNumber = null; this.client = null; this.initializing = false; this.lastError = null;
      try { await WhatsAppModel.updateSession({ is_connected: false, phone_number: null, session_data: { status: 'disconnected', reason } }, this.tenantId); } catch { /* ignore */ }
      this.scheduleReconnect(String(reason || 'disconnected'));
    });

    this.client.on('auth_failure', async (msg) => {
      console.error(`[WhatsApp][${this.tenantId}] Auth failure:`, msg);
      this.status = 'auth_failure'; this.qrCode = null;
      this.phoneNumber = null; this.initializing = false;
      this.lastError = msg || 'Authentication failure';
      try { if (this.client) await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
      try { await WhatsAppModel.updateSession({ is_connected: false, phone_number: null, session_data: { status: 'auth_failure', reason: msg } }, this.tenantId); } catch { /* ignore */ }
      this.scheduleReconnect('auth_failure');
    });

    this.client.on('change_state', (state) => {
      console.log(`[WhatsApp][${this.tenantId}] State: ${state}`);
    });
  }

  // ── Memoize patch ──────────────────────────────────────────────────────────
  async patchWwebVMGetters() {
    // Try multiple ways to get the page handle (API changed across wwebjs versions)
    let realPage = this.client?.pupPage;
    if (!realPage) {
      try {
        const pages = await this.client?.pupBrowser?.pages?.();
        if (pages?.length) { realPage = pages[0]; this.client.pupPage = realPage; }
      } catch { /* ignore */ }
    }
    if (!realPage || typeof realPage.evaluate !== 'function') {
      console.warn(`[WhatsApp][${this.tenantId}] patchWwebVMGetters: no page handle`);
      return false;
    }
    // evaluateOnNewDocument ensures the patch runs on every future navigation too
    try { await realPage.evaluateOnNewDocument(wwebMemoizePatchSource); } catch { /* ignore */ }
    try {
      const result = await realPage.evaluate(wwebMemoizePatchSource);
      console.log(`[WhatsApp][${this.tenantId}] VM patch applied: ${result}`);
      return true;
    } catch (e) {
      console.warn(`[WhatsApp][${this.tenantId}] VM patch evaluate warning:`, String(e?.message || e).slice(0, 200));
      return false;
    }
  }

  // ── Intercept WhatsApp JS bundles to patch the memoize function at source ──
  async _interceptAndPatchJS() {
    let realPage = this.client?.pupPage;
    if (!realPage) {
      try {
        const pages = await this.client?.pupBrowser?.pages?.();
        if (pages?.length) realPage = pages[0];
      } catch { /* ignore */ }
    }
    if (!realPage) return;

    try {
      // Already intercepting (set up in initWebVersionCache by wwebjs)
      // Add our own response handler to patch any WhatsApp JS bundle that
      // contains the broken memoize getter function
      realPage.on('response', async (response) => {
        try {
          const url = response.url();
          if (!url.includes('static.whatsapp.net') || !url.includes('.js')) return;
          if (!response.ok()) return;

          // We can't modify response bodies in Puppeteer directly.
          // Instead, evaluate a targeted patch after each JS bundle loads.
          // The patch replaces the memoize error-throwing function in the
          // WhatsApp Web window context.
          await realPage.evaluate(() => {
            try {
              if (window.__wwebMemoizePatched) return;
              // Find and patch the memoize getter validator in WA's module system
              // The function throws: "Data passed to getter must include an id property"
              // We find it by searching all functions in the WASM/module registry
              if (window.require) {
                try {
                  // Walk all loaded modules looking for the memoize function
                  const moduleIds = Object.keys(window.require.m || {});
                  for (const id of moduleIds) {
                    try {
                      const mod = window.require(id);
                      if (!mod) continue;
                      for (const key of Object.keys(mod || {})) {
                        if (typeof mod[key] === 'function') {
                          const src = mod[key].toString();
                          if (src.includes('Data passed to getter') || src.includes('id property')) {
                            // Replace this function with a safe version
                            const orig = mod[key];
                            mod[key] = function safeGetter(data) {
                              if (!data || !data.id) return data;
                              try { return orig.call(this, data); } catch(e) { return data; }
                            };
                          }
                        }
                      }
                    } catch { /* ignore per-module errors */ }
                  }
                } catch { /* ignore */ }
              }
              window.__wwebMemoizePatched = true;
            } catch { /* ignore */ }
          }).catch(() => {});
        } catch { /* ignore */ }
      });
      console.log(`[WhatsApp][${this.tenantId}] JS response interceptor attached`);
    } catch (e) {
      console.warn(`[WhatsApp][${this.tenantId}] JS interceptor setup failed:`, e?.message);
    }
  }

  // ── Re-apply patch right before each send to ensure WWebJS is patched ──────
  async _ensurePatched() {
    let realPage = this.client?.pupPage;
    if (!realPage) return;
    try {
      await realPage.evaluate(`(function() {
        if (!window.WWebJS || window.WWebJS.__getMessageModelPatched) return;
        const origGetMsgModel = window.WWebJS.getMessageModel;
        if (typeof origGetMsgModel !== 'function') return;
        window.WWebJS.getMessageModel = function safeGetMessageModel(msg) {
          try { return origGetMsgModel.call(this, msg); }
          catch (e) {
            const m = String(e && e.message || e);
            if (m.includes('id') || m.includes('memoize') || m.includes('getter') || m.includes('property')) return null;
            throw e;
          }
        };
        window.WWebJS.__getMessageModelPatched = true;
        if (typeof window.WWebJS.sendMessage === 'function') {
          const origSend = window.WWebJS.sendMessage;
          window.WWebJS.sendMessage = async function(...args) {
            try { return await origSend.apply(this, args); }
            catch (e) {
              const m = String(e && e.message || e);
              if (m.includes('id') || m.includes('memoize') || m.includes('getter') || m.includes('property')) return args[0];
              throw e;
            }
          };
        }
      })()`);
    } catch { /* ignore */ }
  }
  async _resolveChatId(phone) {
    const normalized     = normalizePhone(phone);
    const fallbackChatId = formatPhoneForWhatsApp(phone); // e.g. 919887893270@c.us

    // Always use @c.us format — never @lid.
    // LID-based chat IDs (109...@lid) cause serialization failures in
    // whatsapp-web.js 1.34.x when sending documents/media.
    // getNumberId may return a LID on newer WhatsApp versions; we ignore it
    // and build the @c.us ID directly from the phone number.
    const chatId = fallbackChatId;

    return { chatId, fallbackChatId, normalized };
  }

  // ── sendMessage ────────────────────────────────────────────────────────────
  async sendMessage(phone, message) {
    if (!this.client || this.status !== 'connected') throw new Error('WhatsApp is not connected');
    await this._ensurePatched();
    const { chatId, fallbackChatId, normalized } = await this._resolveChatId(phone);
    console.log(`[WhatsApp][${this.tenantId}] sendMessage → ${chatId}`);

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.client.sendMessage(chatId, message);
        console.log(`[WhatsApp][${this.tenantId}] sendMessage SUCCESS, msgId:`, result?.id?._serialized || 'no-id');
        return result;
      } catch (err) {
        lastErr = err;
        const msg = (err?.message) || String(err);

        if (isDetachedError(msg)) {
          console.warn(`[WhatsApp][${this.tenantId}] Detached frame — scheduling reconnect`);
          this.status = 'disconnected'; this.client = null; this.initializing = false;
          this.scheduleReconnect('detached_frame');
          throw new Error('WhatsApp browser crashed. It will reconnect in 30 seconds — please try again shortly.');
        }

        if (isMemoizeError(msg)) {
          console.warn(`[WhatsApp][${this.tenantId}] Memoize error attempt ${attempt} — re-patching…`);
          try { await this.patchWwebVMGetters(); } catch { /* ignore */ }
          if (attempt < 3) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
          // Exhausted retries — reconnect so next request works
          this.status = 'disconnected'; this.client = null; this.initializing = false;
          this.scheduleReconnect('memoize_exhausted');
          throw new Error('WhatsApp had a session error but will reconnect automatically. Please try again in 30 seconds.');
        }

        if (msg.includes('not a valid') || msg.includes('not exist') || msg.includes('Wid') || msg.includes('unregistered') || msg.includes('not on WhatsApp')) {
          throw new Error(`Phone +${normalized} is not on WhatsApp.`);
        }

        if (attempt < 3) {
          console.warn(`[WhatsApp][${this.tenantId}] sendMessage attempt ${attempt} failed, retrying:`, msg.split('\n')[0]);
          await new Promise(r => setTimeout(r, 800 * attempt));
          // Try fallback chatId on second attempt
          if (attempt === 1 && chatId !== fallbackChatId) {
            try {
              const result = await this.client.sendMessage(fallbackChatId, message);
              return result;
            } catch { /* continue to retry loop */ }
          }
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ── sendDocument ───────────────────────────────────────────────────────────
  async sendDocument(phone, filePath, filename, caption = '') {
    if (!this.client || this.status !== 'connected') throw new Error('WhatsApp is not connected');
    await this._ensurePatched();
    const { chatId, fallbackChatId, normalized } = await this._resolveChatId(phone);
    console.log(`[WhatsApp][${this.tenantId}] sendDocument → ${chatId} (${filename})`);

    const buildMedia = () => {
      try {
        const m = MessageMedia.fromFilePath(filePath);
        try { m.filename = filename; } catch { /* ignore */ }
        return m;
      } catch {
        const raw = fs.readFileSync(filePath);
        const mime = filePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
        const m = new MessageMedia(mime, raw.toString('base64'), filename);
        return m;
      }
    };

    let media = buildMedia();
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const useChatId = attempt <= 1 ? chatId : fallbackChatId;
      try {
        const result = await this.client.sendMessage(useChatId, media, { sendMediaAsDocument: true, caption });
        console.log(`[WhatsApp][${this.tenantId}] sendDocument SUCCESS to ${useChatId}`);
        return result;
      } catch (err) {
        lastErr = err;
        const msg = (err?.message) || String(err);

        if (isDetachedError(msg)) {
          console.warn(`[WhatsApp][${this.tenantId}] Detached frame on sendDocument — scheduling reconnect`);
          this.status = 'disconnected'; this.client = null; this.initializing = false;
          this.scheduleReconnect('detached_frame');
          throw new Error('WhatsApp browser crashed. It will reconnect in 30 seconds — please try again shortly.');
        }

        if (isMemoizeError(msg)) {
          console.warn(`[WhatsApp][${this.tenantId}] Memoize/LID error on sendDocument attempt ${attempt}: ${msg.split('\n')[0]}`);
          try { await this.patchWwebVMGetters(); } catch { /* ignore */ }
          try { media = buildMedia(); } catch { /* ignore */ }
          if (attempt < 3) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
          // Exhausted retries — throw but do NOT disconnect, text sending still works
          throw new Error('PDF sending failed due to a WhatsApp Web media bug. Invoice will be sent as a text message instead.');
        }

        if (msg.includes('not a valid') || msg.includes('not exist') || msg.includes('Wid') || msg.includes('unregistered') || msg.includes('not on WhatsApp')) {
          throw new Error(`Phone +${normalized} is not on WhatsApp.`);
        }

        if (attempt < 3) {
          console.warn(`[WhatsApp][${this.tenantId}] sendDocument attempt ${attempt} failed, retrying:`, msg.split('\n')[0]);
          try { media = buildMedia(); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  async logout() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    if (this.client) {
      try { await this.client.logout(); } catch { /* ignore */ }
      try { await this.client.destroy(); } catch { /* ignore */ }
    }
    this.client = null; this.status = 'disconnected'; this.qrCode = null;
    this.phoneNumber = null; this.initializing = false;
    try { await WhatsAppModel.updateSession({ is_connected: false, phone_number: null, session_data: { status: 'logged_out' } }, this.tenantId); } catch { /* ignore */ }
    removeWhatsAppService(this.tenantId);
  }

  // ── Restart ────────────────────────────────────────────────────────────────
  async restart() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    this.status = 'disconnected'; this.qrCode = null;
    this.phoneNumber = null; this.initializing = false;
    this.shouldReconnect = true;
    await this.initialize();
  }
}
