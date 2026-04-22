/**
 * chatbot_api.js — network / auth layer
 *
 * Handles JWT minting, all HTTP requests to FastAPI, and anonymous
 * session token management.  Exposes window.McpChatbotAPI so the
 * widget file can call apiRequest / handleSessionGone without knowing
 * the auth internals.
 *
 * Load order: this file must come before chatbot_render.js and
 * chatbot_widget.js in web.assets_frontend.
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

    // Synchronous call to Odoo to mint a JWT for this caller.
    // Called on page load and again whenever FastAPI returns 401 or
    // an anonymous session has been rotated.
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

    // All chat traffic goes through here.  Adds Authorization header,
    // refreshes the JWT once on 401 and retries.
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

    // Called when the backend reports the session no longer exists.
    // For anonymous users we rotate the session_token and re-mint the
    // JWT so the next message starts a fresh backend session.
    function handleSessionGone() {
        if (!jwtPartnerId) {
            clearAnonSession();
            fetchJwtSync();
        }
    }

    // Bootstrap — block until we have a JWT + apiBaseUrl.
    fetchJwtSync();

    window.McpChatbotAPI = {
        OPEN_KEY:           OPEN_KEY,
        apiRequest:         apiRequest,
        handleSessionGone:  handleSessionGone,
        getPartnerId:       function () { return jwtPartnerId; },
    };

})();
