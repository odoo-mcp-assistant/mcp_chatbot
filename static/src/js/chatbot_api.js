/**
 * chatbot_api.js — network / auth layer
 */

(function () {
    'use strict';

    var apiBaseUrl   = '';
    var jwtToken     = '';
    var jwtPartnerId = null;

    var ANON_TOKEN_KEY = 'mcp_chatbot_anon_token';
    var OPEN_KEY       = 'mcp_chatbot_open';

    function uuidv4() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function getOrCreateAnonToken() {
        var tok = sessionStorage.getItem(ANON_TOKEN_KEY);
        if (!tok) {
            tok = uuidv4();
            sessionStorage.setItem(ANON_TOKEN_KEY, tok);
        }
        return tok;
    }

    function clearAnonSession() {
        sessionStorage.removeItem(ANON_TOKEN_KEY);
        sessionStorage.removeItem(OPEN_KEY);
    }

    function fetchJwtSync() {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/mcp_chatbot/auth/token', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            id: Date.now(),
            params: { session_token: getOrCreateAnonToken() },
        }));
        if (xhr.status !== 200) {
            console.error('[mcp_chatbot] auth/token HTTP ' + xhr.status);
            return false;
        }
        try {
            var data = JSON.parse(xhr.responseText);
            if (!data || !data.result || !data.result.token) {
                console.error('[mcp_chatbot] auth/token bad response:', data);
                return false;
            }
            apiBaseUrl   = (data.result.fast_api_base_url || '').replace(/\/+$/, '');
            jwtToken     = data.result.token;
            jwtPartnerId = data.result.partner_id || null;
            return true;
        } catch (e) {
            console.error('[mcp_chatbot] auth/token parse error:', e);
            return false;
        }
    }

    // ── Classic JSON request ───────────────────────────────────────────────

    function apiRequest(path, body) {
        function doFetch() {
            return fetch(apiBaseUrl + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + jwtToken,
                },
                body: JSON.stringify(body || {}),
            });
        }
        return doFetch().then(function (res) {
            if (res.status === 401) {
                if (!fetchJwtSync()) { throw new Error('JWT refresh failed'); }
                return doFetch().then(function (r2) {
                    if (!r2.ok) { throw new Error('HTTP ' + r2.status); }
                    return r2.json();
                });
            }
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.json();
        });
    }

    // ── Streaming request (SSE) ───────────────────────────────────────────

    function apiRequestStream(path, body, callbacks) {
        callbacks = callbacks || {};
        var onChunk = callbacks.onChunk || null;
        var onDone  = callbacks.onDone  || null;
        var onError = callbacks.onError || null;
        var onMeta  = callbacks.onMeta  || null;

        function doFetch() {
            return fetch(apiBaseUrl + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + jwtToken,
                },
                body: JSON.stringify(body || {}),
            });
        }

        function parseStream(res) {
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function read() {
                return reader.read().then(function (result) {
                    if (result.done) {
                        if (onDone) { onDone(); }
                        return;
                    }

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop();

                    lines.forEach(function (line) {
                        line = line.trim();
                        if (!line.startsWith('data: ')) { return; }
                        var jsonStr = line.slice(6);
                        if (jsonStr === '[DONE]') { return; }
                        try {
                            var data = JSON.parse(jsonStr);
                            if (data.type === 'meta' && onMeta) {
                                onMeta(data);
                            } else if (data.type === 'chunk' && onChunk) {
                                onChunk(data.text);
                            } else if (data.type === 'done' && onDone) {
                                onDone(data);
                            } else if (data.type === 'error' && onError) {
                                onError(new Error(data.message || 'Stream error'));
                            }
                        } catch (e) {
                            console.error('[mcp_chatbot] SSE parse error:', e);
                        }
                    });

                    return read();
                });
            }

            return read();
        }

        doFetch().then(function (res) {
            if (res.status === 401) {
                if (!fetchJwtSync()) { throw new Error('JWT refresh failed'); }
                return doFetch().then(parseStream);
            }
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return parseStream(res);
        }).catch(function (err) {
            if (onError) { onError(err); }
        });
    }

    function handleSessionGone() {
        if (!jwtPartnerId) {
            clearAnonSession();
            fetchJwtSync();
        }
    }

    fetchJwtSync();

    window.McpChatbotAPI = {
        OPEN_KEY:           OPEN_KEY,
        apiRequest:         apiRequest,
        apiRequestStream:   apiRequestStream,
        handleSessionGone:  handleSessionGone,
        getPartnerId:       function () { return jwtPartnerId; },
    };

})();