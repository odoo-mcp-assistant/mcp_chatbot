/**
     * mcp_chatbot/static/src/js/chatbot_widget.js
     *
     * Design decisions:
     *
     * 1. The session token is stored in sessionStorage (not localStorage).
     *    sessionStorage is cleared automatically when the browser tab is
     *    closed or when the user logs out (Odoo invalidates the session).
     *    This prevents cross-user contamination entirely.
     *
     * 2. The token key includes the Odoo uid (user ID from the cookie/session)
     *    so logging out and logging in as a different user always produces
     *    a different key — even in the same tab.
     *
     * 3. Chat history is fetched from the backend on every widget open,
     *    not stored in the browser. The browser only stores the token.
     *    This is the only source of truth.
     *
     * 4. If the backend session is closed (cron) or not found, the token
     *    is wiped and a fresh one is generated automatically.
     */

    (function () {
        'use strict';

        // ──────────────────────────────────────────────────────────────
        // Get current Odoo uid from the session cookie.
        // Odoo always sets 'frontend_lang' and session cookies but the
        // most reliable uid source is the data-uid attribute Odoo injects
        // on the body, or the session cookie directly.
        // ──────────────────────────────────────────────────────────────

        function getOdooUid() {
            // Odoo 18 injects this on every website page
            var body = document.querySelector('body');
            if (body && body.dataset.uid) {
                return body.dataset.uid;
            }
            // Fallback: check the logged_in meta tag Odoo injects
            var meta = document.querySelector('meta[name="uid"]');
            if (meta) {
                return meta.getAttribute('content');
            }
            return '0';   // 0 = public/anonymous in Odoo
        }

        var uid = getOdooUid();

        // Token key scoped to uid — different users get completely
        // different sessionStorage entries
        var TOKEN_KEY = 'mcp_chatbot_token_' + uid;
        var OPEN_KEY  = 'mcp_chatbot_open_'  + uid;

        // ──────────────────────────────────────────────────────────────
        // Helpers
        // ──────────────────────────────────────────────────────────────

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

        function getSessionToken() {
            var token = sessionStorage.getItem(TOKEN_KEY);
            if (!token) {
                // Embed the uid inside the token so the backend can verify it
                token = uid + '_' + uuidv4();
                sessionStorage.setItem(TOKEN_KEY, token);
            }
            return token;
        }

        function clearSessionToken() {
            sessionStorage.removeItem(TOKEN_KEY);
            sessionStorage.removeItem(OPEN_KEY);
        }

        function jsonRpc(url, params) {
            return fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'call',
                    id: Date.now(),
                    params: params,
                }),
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.error) { throw new Error(data.error.message || 'RPC error'); }
                    return data.result;
                });
        }

        // ──────────────────────────────────────────────────────────────
        // DOM helpers
        // ──────────────────────────────────────────────────────────────

        function appendMessage(container, role, text) {
            var bubble = document.createElement('div');
            bubble.className = 'mcp-chatbot-msg ' + role;
            bubble.textContent = text;
            container.appendChild(bubble);
            container.scrollTop = container.scrollHeight;
        }

        function showTyping(container) {
            var indicator = document.createElement('div');
            indicator.className = 'mcp-chatbot-msg typing';
            indicator.textContent = 'Thinking...';
            container.appendChild(indicator);
            container.scrollTop = container.scrollHeight;
            return indicator;
        }

        function showCompactingBar(container) {
            var bar = document.createElement('div');
            bar.className = 'mcp-compacting-bar';
            bar.innerHTML = (
                '<span>Compacting conversation...</span>' +
                '<div class="mcp-compacting-bar-track">' +
                    '<div class="mcp-compacting-bar-fill"></div>' +
                '</div>'
            );
            container.appendChild(bar);
            container.scrollTop = container.scrollHeight;

            // Remove after 5 seconds
            setTimeout(function () {
                if (bar.parentNode) { bar.parentNode.removeChild(bar); }
            }, 5000);
        }

        // ──────────────────────────────────────────────────────────────
        // Load history from backend
        // ──────────────────────────────────────────────────────────────

        function loadHistoryFromBackend(token, container, callback) {
            jsonRpc('/mcp_chatbot/history', { session_token: token })
                .then(function (result) {
                     // If backend sends back a corrected token, adopt it
                    if (result && result.session_token && result.session_token !== sessionToken) {
                        sessionToken = result.session_token;
                        sessionStorage.setItem(TOKEN_KEY, sessionToken);
                    }
                    if (result && result.summary_interval) {
                        summaryInterval = result.summary_interval;
                    }

                    // result.status = 'closed' | 'not_found' → reset token
                    if (!result || result.status === 'closed' || result.status === 'not_found' || result.status === 'mismatch') {
                        clearSessionToken();
                        sessionToken = getSessionToken();   // fresh token
                        welcomeText  = null;
                        container.innerHTML = '';
                        fetchWelcome(container, callback);
                        return;
                    }

                    var messages = result.messages || [];
                    container.innerHTML = '';

                    if (messages.length === 0) {
                        // Brand new session — show LLM welcome
                        fetchWelcome(container, callback);
                    } else {
                        // Restore messages from backend
                        messages.forEach(function (msg) {
                            appendMessage(container, msg.role, msg.content);
                        });
                        if (callback) { callback(); }
                    }
                })
                .catch(function () {
                    // On error just show welcome
                    fetchWelcome(container, callback);
                });
        }

        // ──────────────────────────────────────────────────────────────
        // Welcome message
        // ──────────────────────────────────────────────────────────────

        function fetchWelcome(container, callback) {
            jsonRpc('/mcp_chatbot/welcome', {})
                .then(function (result) {
                    var msg = (result && result.welcome)
                        ? result.welcome
                        : 'Hello! How can I help you today?';
                    welcomeText = msg;
                    appendMessage(container, 'assistant', msg);
                    if (callback) { callback(); }
                })
                .catch(function () {
                    welcomeText = 'Hello! How can I help you today?';
                    appendMessage(container, 'assistant', welcomeText);
                    if (callback) { callback(); }
                });
        }

        // ──────────────────────────────────────────────────────────────
        // Widget initialisation
        // ──────────────────────────────────────────────────────────────

        // These are declared here so sendMessage can access them
        var sessionToken = null;
        var welcomeText  = null;
        var summaryInterval  = 10;

        function initChatbot() {
            if (window.__mcpChatbotInit) { return; }
            window.__mcpChatbotInit = true;

            var bubble   = document.getElementById('mcp_chatbot_bubble');
            var chatWin  = document.getElementById('mcp_chatbot_window');
            var closeBtn = chatWin && chatWin.querySelector('.mcp-chatbot-close');
            var msgArea  = document.getElementById('mcp_chatbot_messages');
            var input    = document.getElementById('mcp_chatbot_input');
            var sendBtn  = document.getElementById('mcp_chatbot_send');

            if (!bubble || !chatWin || !msgArea || !input || !sendBtn) { return; }

            sessionToken = getSessionToken();
            var isOpen   = sessionStorage.getItem(OPEN_KEY) === '1';

            // ── Open / close ──────────────────────────────────────────
            function openWindow() {
                chatWin.classList.remove('d-none');
                isOpen = true;
                sessionStorage.setItem(OPEN_KEY, '1');
                msgArea.innerHTML = '';
                loadHistoryFromBackend(sessionToken, msgArea, function () {
                    input.focus();
                });
            }

            function closeWindow() {
                chatWin.classList.add('d-none');
                isOpen = false;
                sessionStorage.setItem(OPEN_KEY, '0');
                msgArea.innerHTML = '';   // clear DOM — backend is source of truth
            }

            bubble.addEventListener('click', function () {
                isOpen ? closeWindow() : openWindow();
            });

            if (closeBtn) {
                closeBtn.addEventListener('click', closeWindow);
            }

            if (isOpen) {
                openWindow();
            }

            // ── Send message ──────────────────────────────────────────
            function sendMessage() {
                var text = input.value.trim();
                if (!text) { return; }

                appendMessage(msgArea, 'user', text);
                input.value = '';
                sendBtn.disabled = true;

                // ── Show compacting bar every 10 messages ─────────────────
                // Count existing messages in the DOM (excluding typing indicators)
                var msgCount = msgArea.querySelectorAll('.mcp-chatbot-msg.user, .mcp-chatbot-msg.assistant').length;
                var isCompacting = msgCount > 0 && msgCount % 10 === 0;
                var compactStart = Date.now();

                if (isCompacting) {
                    showCompactingBar(msgArea);
                }

                // Hold the RPC result here until we are ready to display it
                var pendingReply   = null;
                var pendingError   = false;
                var rpcDone        = false;
                var typingEl       = null;

                function displayReply() {
                    if (typingEl) { typingEl.remove(); }
                    if (pendingError) {
                        appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.');
                    } else if (pendingReply && pendingReply.error === 'session_mismatch') {
                        clearSessionToken();
                        sessionToken = getSessionToken();
                        welcomeText  = null;
                        msgArea.innerHTML = '';
                        fetchWelcome(msgArea, null);
                        appendMessage(msgArea, 'assistant', 'Your session was reset. Please resend your message.');
                    } else {
                        appendMessage(msgArea, 'assistant', pendingReply && pendingReply.reply
                            ? pendingReply.reply
                            : 'Sorry, I could not get a reply.');
                    }
                    sendBtn.disabled = false;
                    input.focus();
                }

                // Show typing indicator — immediately if no compacting, after 5s if compacting
                var typingDelay = isCompacting ? 5000 : 0;
                setTimeout(function () {
                    typingEl = showTyping(msgArea);
                    // If RPC already finished while we were waiting, display immediately
                    if (rpcDone) { displayReply(); }
                }, typingDelay);

                var payload = { session_token: sessionToken, message: text };

                // Pass welcome text on first message so backend saves it
                if (welcomeText) {
                    payload.welcome = welcomeText;
                    welcomeText = null;
                }

                jsonRpc('/mcp_chatbot/message', payload)
                    .then(function (result) {
                        pendingReply = result;
                    })
                    .catch(function (err) {
                        pendingError = true;
                        console.error('[mcp_chatbot] RPC error:', err);
                    })
                    .finally(function () {
                        rpcDone = true;
                        // Only display if typing indicator is already visible
                        // (i.e. the 5s compacting delay has already passed)
                        if (typingEl) { displayReply(); }
                    });
            }

            sendBtn.addEventListener('click', sendMessage);

            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
        }

        // ──────────────────────────────────────────────────────────────
        // Bootstrap
        // ──────────────────────────────────────────────────────────────
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initChatbot);
        } else {
            initChatbot();
        }

    })();