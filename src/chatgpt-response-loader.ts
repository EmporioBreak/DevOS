export const CHATGPT_RESPONSE_LOADER_SOURCE = String.raw`
(function () {
  if (window.__DEVOS_ARM_STREAM__) return;
  var state = window.__DEVOS_STREAM_STATE__ = { request: 0, armed: false, text: null, failed: false };
  window.__DEVOS_ARM_STREAM__ = function () {
    state = window.__DEVOS_STREAM_STATE__ = { request: state.request + 1, armed: true, text: null, failed: false };
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
      eligible = pending.armed && url.origin === window.location.origin &&
        /^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname) && method === 'POST';
    } catch {}

    var response;
    try { response = await originalFetch.apply(this, args); }
    catch (error) { if (eligible && pending === state) pending.failed = true; throw error; }

    if (!eligible || pending !== state || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
      return response;
    }

    pending.armed = false;
    var reader;
    try { reader = response.clone().body.getReader(); }
    catch { pending.failed = true; return response; }

    var decoder = new TextDecoder('utf-8');
    var buffer = '', responseText = '', completedResponse = null, failed = false, complete = false;

    function envelopeText(value) {
      return value && Array.isArray(value.output)
        ? value.output.filter(function (item) { return item.type === 'message' && item.role === 'assistant'; })
          .map(function (item) {
            return (item.content || []).filter(function (part) {
              return part.type === 'output_text' && typeof part.text === 'string';
            }).map(function (part) { return part.text; }).join('');
          }).join('\n')
        : '';
    }

    function readEvent(event) {
      var data = event.split(/\r?\n/)
        .filter(function (line) { return line.startsWith('data:'); })
        .map(function (line) { return line.slice(5).trimStart(); }).join('\n');
      if (!data) return;
      if (data === '[DONE]') { complete = true; return; }

      var obj = JSON.parse(data);
      if (!obj || typeof obj !== 'object') return;
      if (obj.type === 'message_stream_complete') { complete = true; return; }
      if (obj.type === 'response.failed' || obj.type === 'response.incomplete' ||
          obj.type === 'response.cancelled' || obj.error) { failed = true; return; }
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') responseText += obj.delta;
      else if (obj.type === 'response.output_text.done' && typeof obj.text === 'string') responseText = obj.text;
      else if (obj.type === 'response.completed') completedResponse = obj.response;
    }

    (async function () {
      try {
        while (true) {
          var chunk = await reader.read();
          buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          var events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop();
          events.forEach(readEvent);
          if (chunk.done || complete) {
            if (buffer.trim()) readEvent(buffer);
            break;
          }
        }

        var text = completedResponse ? envelopeText(completedResponse) : responseText;
        if (pending === state) {
          pending.failed = failed || !complete || !text.trim();
          pending.text = pending.failed ? null : text;
        }
      } catch {
        if (pending === state) pending.failed = true;
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    })();

    return response;
  };
})();
`;
