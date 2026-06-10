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
 *
 * ──────────────────────────────────────────────────────────────────
 * High-level flow:
 *   1. On page load, this file synchronously calls Odoo's
 *      /mcp_chatbot/auth/token route to obtain:
 *        - a signed JWT identifying the caller,
 *        - the base URL of the FastAPI sidecar,
 *        - the partner_id (null for anonymous visitors).
 *   2. After that, every chat-related request goes through apiRequest(),
 *      which targets the FastAPI sidecar directly with the JWT in the
 *      Authorization header.  Odoo is not in the request path anymore
 *      except when the JWT must be refreshed (401).
 * ──────────────────────────────────────────────────────────────────
 */

// IIFE (Immediately Invoked Function Expression) — wraps everything
// in a private scope so internal variables (jwtToken, etc.) are not
// leaked to window.  Only the explicit window.McpChatbotAPI export
// is visible to the rest of the page.
(function () {
    'use strict';

    // ─── Private module-level state ───────────────────────────────
    // These three variables hold the authentication state for the
    // current browser tab.  They are filled by fetchJwtSync() and
    // consumed by apiRequest().  They never leave this IIFE.

    var apiBaseUrl   = '';   // Base URL of the FastAPI sidecar (e.g. "https://api.example.com")
    var jwtToken     = '';   // The signed JWT we attach to every FastAPI request
    var jwtPartnerId = null; // Odoo partner id encoded in the JWT (null = anonymous visitor)

    // sessionStorage keys.  sessionStorage (not localStorage) is used
    // on purpose: it is automatically cleared when the browser tab
    // closes, which prevents cross-user contamination on shared
    // computers.
    var ANON_TOKEN_KEY = 'mcp_chatbot_anon_token'; // Stores the anonymous UUID for this tab
    var OPEN_KEY       = 'mcp_chatbot_open';       // Remembers whether the bubble was open

    // ─── UUID generation ─────────────────────────────────────────
    // Produces a RFC 4122 version-4 UUID used as the anonymous
    // session_token.  Prefers the secure crypto API; falls back to
    // Math.random() only on legacy browsers that do not expose it.
    function uuidv4() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID();
        }
        // Fallback template — fills "x" with random hex digits and
        // forces the version (4) and variant bits to match RFC 4122.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // ─── Anonymous identity helpers ──────────────────────────────
    // Returns the anonymous UUID for this tab; creates one and
    // persists it the first time it is called.  The same UUID is
    // reused across page navigations within the tab, so the visitor
    // keeps the same chat session even after refreshing the page.
    function getOrCreateAnonToken() {
        var tok = sessionStorage.getItem(ANON_TOKEN_KEY);
        if (!tok) {
            tok = uuidv4();                            // ← generated client-side
            sessionStorage.setItem(ANON_TOKEN_KEY, tok);
        }
        return tok;
    }

    // Wipes the anonymous identity so the next fetchJwtSync() call
    // will generate a brand-new UUID.  Triggered when the backend
    // reports the session is gone (idle timeout) or when the user
    // explicitly ends the conversation.
    function clearAnonSession() {
        sessionStorage.removeItem(ANON_TOKEN_KEY);
        sessionStorage.removeItem(OPEN_KEY);
    }

    // ─── JWT minting (the only Odoo call this file makes) ────────
    // Synchronous XMLHttpRequest to Odoo's /mcp_chatbot/auth/token
    // route.  Synchronous because the JWT must be available before
    // any other code (chatbot_widget.js) attempts a FastAPI call.
    //
    // Request body uses Odoo's JSON-RPC envelope; params.session_token
    // carries the anonymous UUID created above.  Odoo looks at the
    // session cookie (sent automatically by the browser because the
    // request is same-origin) to decide whether the caller is a
    // logged-in user or anonymous, and signs a JWT accordingly.
    //
    // Called in three situations:
    //   - On script load (bootstrap, line further below).
    //   - When apiRequest() catches a 401 (JWT expired).
    //   - After handleSessionGone() rotates the anonymous identity.
    function fetchJwtSync() {
        var xhr = new XMLHttpRequest();
        // The third argument `false` makes the call SYNCHRONOUS — the
        // JS thread blocks until the response is received.  Required
        // because the rest of the addon assumes jwtToken is ready.
        xhr.open('POST', '/mcp_chatbot/auth/token', false);
        xhr.setRequestHeader('Content-Type', 'application/json');

        // Odoo JSON-RPC envelope expected by routes declared with
        // type='json'.  Odoo will unpack `params` into the controller
        // method's keyword arguments, so `session_token` here lands
        // directly as the `session_token=` parameter of
        // AuthController.issue_token().
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
            // JSON-RPC responses wrap the actual payload in `result`.
            var data = JSON.parse(xhr.responseText);
            if (!data || !data.result || !data.result.token) {
                console.error('[mcp_chatbot] auth/token bad response:', data);
                return false;
            }
            // Store everything we need for the rest of the session.
            // Trailing slashes on the base URL are stripped so we
            // never produce double-slashes when concatenating paths.
            apiBaseUrl   = (data.result.fast_api_base_url || '').replace(/\/+$/, '');
            jwtToken     = data.result.token;
            jwtPartnerId = data.result.partner_id || null;
            return true;
        } catch (e) {
            console.error('[mcp_chatbot] auth/token parse error:', e);
            return false;
        }
    }

    // ─── FastAPI client ──────────────────────────────────────────
    // The single function used by chatbot_widget.js to talk to the
    // FastAPI sidecar.  It centralises three concerns:
    //   1. Prepends apiBaseUrl so callers can pass relative paths.
    //   2. Attaches "Authorization: Bearer <jwt>" on every request.
    //   3. Transparently refreshes the JWT on 401 and retries once.
    //
    // - path:   FastAPI path, e.g. "/mcp_chatbot/message"
    // - body:   payload object (ignored on GET)
    // - method: HTTP verb; defaults to 'POST'
    function apiRequest(path, body, method) {
        method = method || 'POST';

        // Inner helper so the same fetch can be replayed after a JWT refresh without duplicating the option-building logic.
        function doFetch() {
            var opts = {
                method: method,
                headers: { 'Authorization': 'Bearer ' + jwtToken },
            };
            // Read-only verbs must not carry a body — some servers
            // (and CORS preflights) reject GETs with a payload.
            if (method !== 'GET') {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(body || {});
            }
            return fetch(apiBaseUrl + path, opts);
        }

        return doFetch().then(function (res) {
            // 401 = JWT expired or invalid.  Mint a new one against
            // Odoo and retry the original call exactly once.  If the
            // retry still fails we surface the error to the caller.
            if (res.status === 401) {
                if (!fetchJwtSync()) { throw new Error('JWT refresh failed'); }
                return doFetch().then(function (r2) {
                    if (!r2.ok) { throw new Error('HTTP ' + r2.status); }
                    return r2.json();
                });
            }
            // Any other non-2xx → propagate as a JS error so the
            // widget can fall back to its "An error occurred" bubble.
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.json();
        });
    }

    // ─── FastAPI streaming client (Server-Sent Events) ───────────
    // Like apiRequest, but for the SSE /message endpoint. POSTs the body
    // with the JWT, then reads the HTTP response as a stream and calls
    // onEvent(evt) for every parsed `data:` frame as it arrives. Returns a
    // promise that resolves when the stream ends and rejects on a hard
    // failure. Mirrors apiRequest's one-shot JWT refresh on a 401.
    //
    // - path:    FastAPI path, e.g. "/mcp_chatbot/message"
    // - body:    payload object
    // - onEvent: callback invoked with each decoded event object
    function streamRequest(path, body, onEvent) {
        function doFetch() {
            return fetch(apiBaseUrl + path, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + jwtToken,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body || {}),
            });
        }

        // Read res.body to completion, splitting the byte stream into SSE
        // frames (separated by a blank line) and dispatching each one.
        function consume(res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            var reader  = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer  = '';

            // A frame may hold multiple lines; we only care about `data:` ones.
            function dispatch(frame) {
                var dataLines = frame.split('\n')
                    .filter(function (l) { return l.indexOf('data:') === 0; })
                    .map(function (l) { return l.slice(5).replace(/^ /, ''); });
                if (dataLines.length === 0) { return; }
                var payload = dataLines.join('\n');
                try {
                    onEvent(JSON.parse(payload));
                } catch (e) {
                    console.warn('[mcp_chatbot] bad SSE frame:', payload);
                }
            }

            function pump() {
                return reader.read().then(function (chunk) {
                    if (chunk.done) {
                        // Flush a trailing frame that wasn't \n\n-terminated.
                        if (buffer.trim()) { dispatch(buffer); }
                        return;
                    }
                    buffer += decoder.decode(chunk.value, { stream: true });
                    var frames = buffer.split('\n\n');
                    buffer = frames.pop();   // keep the (possibly partial) last frame
                    frames.forEach(dispatch);
                    return pump();
                });
            }
            return pump();
        }

        return doFetch().then(function (res) {
            // 401 → mint a fresh JWT against Odoo and replay the request once.
            if (res.status === 401) {
                if (!fetchJwtSync()) { throw new Error('JWT refresh failed'); }
                return doFetch().then(consume);
            }
            return consume(res);
        });
    }

    // ─── Stale-session recovery ──────────────────────────────────
    // Called by the widget when FastAPI reports the chat session
    // was closed server-side (idle-timeout cron, manual end-session,
    // etc.).  Only anonymous identities need to be rotated: logged-in
    // users keep their partner_id, so their JWT stays valid.
    function handleSessionGone() {
        if (!jwtPartnerId) {
            clearAnonSession();   // wipe the old UUID from sessionStorage
            fetchJwtSync();       // mint a fresh JWT bound to a new UUID
        }
    }

    // ─── Bootstrap ───────────────────────────────────────────────
    // Runs at script-load time, BEFORE chatbot_widget.js executes.
    // Blocks until the JWT and FastAPI base URL are available so the
    // widget can call apiRequest() right away without race conditions.
    fetchJwtSync();

    // ─── Public surface ──────────────────────────────────────────
    // chatbot_widget.js reaches the network only through these four
    // entry points.  It never sees jwtToken, apiBaseUrl, or the
    // anonymous UUID — that encapsulation is the whole point of
    // splitting this file out from the widget.
    window.McpChatbotAPI = {
        OPEN_KEY:           OPEN_KEY,           // sessionStorage key for "is the bubble open?"
        apiRequest:         apiRequest,         // Authenticated FastAPI client
        streamRequest:      streamRequest,      // Authenticated SSE client (/message)
        handleSessionGone:  handleSessionGone,  // Rotate anon identity after a closed session
        getPartnerId:       function () { return jwtPartnerId; }, // Read-only accessor
    };

    // ─── Security note: exposing partner_id client-side ──────────
    // partner_id is an INTEGER identifier, not a credential.  The
    // user already knows their own partner_id (it appears in Odoo
    // URLs, profile pages, etc.), and they never see anyone else's
    // here — the JS only stores the value Odoo derived from their
    // own session cookie.
    //
    // The real credential is the JWT.  FastAPI authenticates every
    // request by reading the `partner_id` claim from the SIGNED JWT
    // and verifying the signature with JWT_SECRET; the jwtPartnerId
    // variable above is used only for local UI decisions (e.g. the
    // `if (!jwtPartnerId)` check in handleSessionGone).  A user who
    // tampers with that variable can confuse their own UI but cannot
    // impersonate anyone — forging a JWT claiming a different
    // partner_id would fail signature verification server-side.
    //
    // Rule of thumb: identifiers are public, credentials are secret.

})();
