'use strict';
const { net, session } = require('electron');

/**
 * GET JSON from a game's loopback API.
 *
 * Riot's Live Client Data API serves its own certificate on 127.0.0.1:2999.
 * Rather than turning off TLS checking process-wide (which would also weaken
 * the Spotify calls), a dedicated Electron session trusts exactly that one
 * loopback origin and nothing else. Every other request in the app keeps
 * Chromium's normal certificate verification.
 */

const TRUSTED_HOST = '127.0.0.1';
const TRUSTED_PORT = 2999;
const PARTITION = 'valotunes-localapi';

let localSession = null;

function getLocalSession() {
  if (localSession) return localSession;
  localSession = session.fromPartition(PARTITION);
  localSession.setCertificateVerifyProc((request, callback) => {
    const okHost = request.hostname === TRUSTED_HOST;
    // 0 = accept, -3 = fall back to Chromium's own verification result.
    callback(okHost ? 0 : -3);
  });
  return localSession;
}

function getJson(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const request = net.request({ method: 'GET', url, session: getLocalSession() });
    const timer = setTimeout(() => {
      finish(reject, new Error('timeout'));
      try { request.abort(); } catch { /* already gone */ }
    }, timeoutMs);

    request.on('response', response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString('utf8'); });
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(reject, new Error('HTTP ' + response.statusCode));
          return;
        }
        try { finish(resolve, JSON.parse(body)); }
        catch (e) { finish(reject, new Error('bad JSON: ' + e.message)); }
      });
      response.on('error', e => { clearTimeout(timer); finish(reject, e); });
    });

    request.on('error', e => { clearTimeout(timer); finish(reject, e); });
    request.end();
  });
}

module.exports = { getJson, TRUSTED_HOST, TRUSTED_PORT };
