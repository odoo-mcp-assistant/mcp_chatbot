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
     * 2. For logged‑in users, no token is stored. The session is identified
     *    by the partner_id provided by the backend.
     *
     * 3. Chat history is fetched from the backend on every widget open,
     *    not stored in the browser. The browser only stores the token
     *    for anonymous users.
     *
     * 4. If the backend session is closed (cron) or not found, the token
     *    is wiped and a fresh one is generated automatically for anonymous users.
     */

    (function () {
        'use strict';

        function getOdooUid() {
            // Make synchronous RPC call to backend to get the actual UID
            var result = null;
            
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/mcp_chatbot/get_uid', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            
            var payload = JSON.stringify({
                jsonrpc: '2.0',
                method: 'call',
                id: Date.now(),
                params: {}
            });
            
            xhr.send(payload);
            
            if (xhr.status === 200) {
                try {
                    var response = JSON.parse(xhr.responseText);
                    if (response && response.result && response.result.uid) {
                        result = response.result.uid;
                    }
                } catch (e) {
                    console.error('[mcp_chatbot] Failed to parse UID response:', e);
                }
            }
            return result || '0';   // 0 = public/anonymous in Odoo
        }

        var uid = getOdooUid();

        // Token key scoped to uid — different users get completely
        // different sessionStorage entries.
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
            // For logged‑in users, no token is used.
            if (uid !== '0') {
                return null;
            }

            var token = sessionStorage.getItem(TOKEN_KEY);
            if (!token) {
                token = uuidv4();
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
            var payload = {};
            if (token) {
                payload.session_token = token;
            }
            jsonRpc('/mcp_chatbot/history', payload)
                .then(function (result) {
                    if (result && result.summary_interval) {
                        summaryInterval = result.summary_interval;
                    }
                    // If session is closed or not found, reset the token
                    if (!result || result.status === 'closed' || result.status === 'not_found') {
                        // Clear the old token and generate a new one
                        clearSessionToken();
                        sessionToken = getSessionToken();  // this will create a new token
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
                        // Restore messages from backend — real session exists
                        messages.forEach(function (msg) {
                            appendMessage(container, msg.role, msg.content);
                        });
                        if (callback) { callback(true); }
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
                    if (callback) { callback(false); }   // no real session yet
                })
                .catch(function () {
                    welcomeText = 'Hello! How can I help you today?';
                    appendMessage(container, 'assistant', welcomeText);
                    if (callback) { callback(false); }   // no real session yet
                });
        }

        // ──────────────────────────────────────────────────────────────
        // Header + tooltip helpers
        // ──────────────────────────────────────────────────────────────

        function updateHeaderName(name) {
            var titleEl = document.getElementById('mcp_chatbot_title');
            if (titleEl && name) { titleEl.textContent = name; }
            var tooltipNameEl = document.getElementById('mcp_chatbot_tooltip_name');
            if (tooltipNameEl && name) { tooltipNameEl.textContent = name; }
        }

        function updateStatus(status) {
            var statusEl  = document.querySelector('.mcp-chatbot-status');
            var inputEl   = document.getElementById('mcp_chatbot_input');
            var sendEl    = document.getElementById('mcp_chatbot_send');

            if (status === 'offline') {
                if (statusEl) {
                    statusEl.textContent = 'Offline';
                    statusEl.classList.add('mcp-status-offline');
                    statusEl.classList.remove('mcp-status-online');
                }
                if (inputEl) {
                    inputEl.disabled    = true;
                    inputEl.placeholder = 'Chat is currently unavailable.';
                }
                if (sendEl)  { sendEl.disabled = true; }
            } else {
                if (statusEl) {
                    statusEl.textContent = 'Online';
                    statusEl.classList.add('mcp-status-online');
                    statusEl.classList.remove('mcp-status-offline');
                }
                if (inputEl) {
                    inputEl.disabled    = false;
                    inputEl.placeholder = 'Type your message...';
                }
                if (sendEl)  { sendEl.disabled = false; }
            }
        }

        // Fetch bot metadata once on page load — populates header title, tooltip, and status badge
        jsonRpc('/mcp_chatbot/info', {})
            .then(function (result) {
                if (result && result.bot_name) { updateHeaderName(result.bot_name); }
                if (result && result.status)   { updateStatus(result.status); }
            })
            .catch(function () {});  // silent — fallbacks stay as "AI Assistant" / "Online"

        // ──────────────────────────────────────────────────────────────
        // Widget initialisation
        // ──────────────────────────────────────────────────────────────

        // These are declared here so sendMessage can access them
        var sessionToken = null;
        var welcomeText  = null;
        var summaryInterval = 10;   // default — overridden by backend response

        function initChatbot() {
            if (window.__mcpChatbotInit) { return; }
            window.__mcpChatbotInit = true;

            var bubble   = document.getElementById('mcp_chatbot_bubble');
            var bubbleTooltip = document.getElementById('mcp_chatbot_bubble_tooltip');
            var chatWin  = document.getElementById('mcp_chatbot_window');
            var closeBtn = chatWin && chatWin.querySelector('.mcp-chatbot-close');
            var endSessionBtn = chatWin && chatWin.querySelector('.mcp-chatbot-end-session');
            var confirmOverlay = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-overlay');
            var confirmYes    = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-yes');
            var confirmNo     = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-no');
            var msgArea  = document.getElementById('mcp_chatbot_messages');
            var input    = document.getElementById('mcp_chatbot_input');
            var sendBtn  = document.getElementById('mcp_chatbot_send');

            if (!bubble || !chatWin || !msgArea || !input || !sendBtn) { return; }

            sessionToken = getSessionToken();
            var isOpen   = sessionStorage.getItem(OPEN_KEY) === '1';

            // ── Bubble tooltip hover ──────────────────────────────────
            if (bubble && bubbleTooltip) {
                bubble.addEventListener('mouseenter', function () {
                    if (!isOpen) { bubble.classList.add('mcp-bubble-hovered'); }
                });
                bubble.addEventListener('mouseleave', function () {
                    bubble.classList.remove('mcp-bubble-hovered');
                });
            }

            // ── End-session button visibility ─────────────────────────
            function setEndSessionVisible(visible) {
                if (!endSessionBtn) { return; }
                if (visible) {
                    endSessionBtn.classList.remove('d-none');
                } else {
                    endSessionBtn.classList.add('d-none');
                }
            }
            // Hidden until we confirm a real session exists
            setEndSessionVisible(false);

            // ── Open / close ──────────────────────────────────────────
            function openWindow() {
                chatWin.classList.remove('d-none');
                isOpen = true;
                sessionStorage.setItem(OPEN_KEY, '1');
                if (bubble) { bubble.classList.remove('mcp-bubble-hovered'); }
                msgArea.innerHTML = '';
                loadHistoryFromBackend(sessionToken, msgArea, function (hasSession) {
                    setEndSessionVisible(hasSession);
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

            // ── End session (with confirmation) ──────────────────────
            if (endSessionBtn && confirmOverlay) {
                endSessionBtn.addEventListener('click', function () {
                    confirmOverlay.classList.remove('d-none');
                });

                confirmNo.addEventListener('click', function () {
                    confirmOverlay.classList.add('d-none');
                });

                confirmYes.addEventListener('click', function () {
                    confirmOverlay.classList.add('d-none');
                    var payload = {};
                    if (sessionToken) {
                        payload.session_token = sessionToken;
                    }
                    jsonRpc('/mcp_chatbot/close', payload)
                        .then(function () {
                            setEndSessionVisible(false);
                            clearSessionToken();
                            sessionToken = getSessionToken();
                            chatWin.classList.add('d-none');
                            isOpen = false;
                            sessionStorage.setItem(OPEN_KEY, '0');
                            msgArea.innerHTML = '';
                        })
                        .catch(function (err) {
                            console.error('[mcp_chatbot] Failed to close session:', err);
                        });
                });
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
                var msgCount = msgArea.querySelectorAll('.mcp-chatbot-msg.user, .mcp-chatbot-msg.assistant').length;
                var isCompacting = msgCount > 0 && msgCount % summaryInterval === 0;

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
                    } else {
                        appendMessage(msgArea, 'assistant', pendingReply && pendingReply.reply
                            ? pendingReply.reply
                            : 'Sorry, I could not get a reply.');
                        setEndSessionVisible(true);   // session now exists
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

                var payload = { message: text };
                // Include session_token only for anonymous users
                if (sessionToken) {
                    payload.session_token = sessionToken;
                }
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