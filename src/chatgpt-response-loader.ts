/**
 * Adapted from ApiBeam's fetch/SSE loader (MIT; see vendor/apibeam/LICENSE).
 * Upstream: 03cb1731a19b5c96acfc075e230e28d2616c8bad/src/pages/content/loader.ts
 * Literal JavaScript keeps this init script independent of tsx serialization.
 */
export const CHATGPT_RESPONSE_LOADER_SOURCE = String.raw`
(function () {
  if (window.__DEVOS_ARM_STREAM__) return;
  var state = window.__DEVOS_STREAM_STATE__ = { request: 0, armed: false, started: false, text: null, failed: false, messageId: null, submissionClaimed: false };
  window.__DEVOS_ARM_STREAM__ = function () {
    state = window.__DEVOS_STREAM_STATE__ = { request: state.request + 1, armed: true, started: false, text: null, failed: false, messageId: null, submissionClaimed: false };
    return state.request;
  };
  var originalFetch = window.fetch;
  window.fetch = async function (...args) {
    var pending = state;
    var eligible = false;
    try {
      var input = args[0], init = args[1] || {};
      var url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.origin);
      var method = String(init.method || input.method || 'GET').toUpperCase();
      eligible = pending.armed && !pending.submissionClaimed && url.origin === window.location.origin && /^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname) && method === 'POST';
    } catch { /* Non-conversation fetches pass through untouched. */ }
    if (eligible) {
      pending.submissionClaimed = true;
      try {
        var body = typeof init.body === 'string' ? init.body : input && typeof input.clone === 'function' ? await input.clone().text() : null;
        var payload = body ? JSON.parse(body) : null;
        var messages = payload && payload.messages;
        var user = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
        if (pending === state && user && user.author && user.author.role === 'user' && typeof user.id === 'string' && user.id.length > 0 && user.id.length <= 200) pending.messageId = user.id;
      } catch { /* Unknown submission identity disables read recovery, never the page fetch. */ }
    }
    var response;
    try { response = await originalFetch.apply(this, args); }
    catch (error) { if (eligible && pending === state) pending.failed = true; throw error; }
    if (eligible && pending === state && !(response.headers.get('content-type') || '').includes('text/event-stream')) pending.failed = true;
    if (!eligible || pending !== state || !pending.armed || !(response.headers.get('content-type') || '').includes('text/event-stream')) return response;
    pending.armed = false;
    pending.started = true;
    var reader;
    try { reader = response.clone().body.getReader(); } catch { pending.failed = true; return response; }
    var decoder = new TextDecoder('utf-8');
    var buffer = '', doc = null, lastContentPath = null, responseText = '', completedResponse = null, failed = false, complete = false;
    function keys(path) { return String(path).split('/').slice(1).map(function (key) { return key.replace(/~1/g, '/').replace(/~0/g, '~'); }); }
    function getByPath(obj, path) {
      for (var key of keys(path)) { if (obj == null || key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined; obj = obj[key]; }
      return obj;
    }
    function setByPath(obj, path, value) {
      var pathKeys = keys(path);
      if (!pathKeys.length || pathKeys.some(function (key) { return key === '__proto__' || key === 'constructor' || key === 'prototype'; })) return;
      var last = pathKeys.pop();
      for (var key of pathKeys) { if (obj == null) return; obj = obj[key]; }
      if (obj == null) return;
      if (Array.isArray(obj) && last === '-') obj.push(value); else obj[last] = value;
    }
    function applyDelta(delta) {
      if (!delta || typeof delta !== 'object') return;
      var p = delta.p, o = delta.o, v = delta.v;
      if (Array.isArray(v) && (o === 'patch' || (p === undefined && o === undefined))) { v.forEach(applyDelta); return; }
      if (v !== null && typeof v === 'object' && p === undefined && o === undefined) { doc = v; lastContentPath = null; return; }
      if (o === 'add' || o === 'replace') {
        if (p === undefined || p === '' || p === null) { doc = typeof v === 'string' ? JSON.parse(v) : v; lastContentPath = null; }
        else if (doc) setByPath(doc, p, v);
        return;
      }
      if (o === 'append') {
        lastContentPath = p || null;
        if (doc && p) {
          var target = getByPath(doc, p);
          if (typeof target === 'string' && typeof v === 'string') setByPath(doc, p, target + v);
          else if (Array.isArray(target)) target.push(v);
        }
        return;
      }
      if (typeof v === 'string' && doc && lastContentPath) {
        var target = getByPath(doc, lastContentPath);
        if (typeof target === 'string') setByPath(doc, lastContentPath, target + v);
      }
    }
    function textFromDoc(value) {
      var message = value && (value.message || value);
      if (!message || !message.author || message.author.role !== 'assistant' || (message.channel && message.channel !== 'final')) return '';
      var content = message.content;
      return content && content.content_type === 'text' && Array.isArray(content.parts) ? content.parts.filter(function (part) { return typeof part === 'string'; }).join('') : '';
    }
    function envelopeText(value) {
      return value && Array.isArray(value.output) ? value.output.filter(function (item) { return item.type === 'message' && item.role === 'assistant'; }).map(function (item) {
        return (item.content || []).filter(function (part) { return part.type === 'output_text' && typeof part.text === 'string'; }).map(function (part) { return part.text; }).join('');
      }).join('\n') : '';
    }
    function readEvent(event) {
      var lines = event.split(/\r?\n/);
      var data = lines.filter(function (line) { return line.startsWith('data:'); }).map(function (line) { return line.slice(5).trimStart(); }).join('\n');
      if (!data) return;
      if (data === '[DONE]') { complete = true; return; }
      var obj = JSON.parse(data);
      if (!obj || typeof obj !== 'object') return;
      if (obj.type === 'message_stream_complete') { complete = true; return; }
      if (obj.type === 'response.failed' || obj.type === 'response.incomplete' || obj.type === 'response.cancelled' || obj.error) { failed = true; return; }
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') responseText += obj.delta;
      else if (obj.type === 'response.output_text.done' && typeof obj.text === 'string') responseText = obj.text;
      else if (obj.type === 'response.completed') completedResponse = obj.response;
      else if (obj.message) { doc = obj; lastContentPath = null; }
      else applyDelta(obj);
    }
    async function readStream() {
      try {
        while (true) {
          var chunk = await reader.read();
          buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          var events = buffer.split(/\r?\n\r?\n/); buffer = events.pop();
          events.forEach(readEvent);
          if (chunk.done || complete) { if (buffer.trim()) readEvent(buffer); break; }
        }
        var text = doc ? textFromDoc(doc) : completedResponse ? envelopeText(completedResponse) : responseText;
        if (pending === state) {
          var message = doc && (doc.message || doc);
          var finished = complete || (message && message.status === 'finished_successfully' && message.end_turn === true) || !!completedResponse;
          pending.failed = failed || !finished || !text.trim();
          pending.text = pending.failed ? null : text;
        }
      } catch { if (pending === state) pending.failed = true; }
      finally { if (complete) void reader.cancel().catch(function () {}); reader.releaseLock(); }
    }
    void readStream();
    return response;
  };
})();
`;
