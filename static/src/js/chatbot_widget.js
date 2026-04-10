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

            if (role === 'assistant') {
                var inner = document.createElement('div');
                inner.className = 'mcp-assistant-inner';

                var textSpan = document.createElement('span');
                textSpan.className = 'mcp-assistant-text';
                textSpan.textContent = text;

                var avatar = document.createElement('img');
                avatar.className = 'mcp-assistant-avatar';
                // Use the same logo shown in the header
                var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
                avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/chat-bot-logo.png';
                avatar.alt = '';

                inner.appendChild(avatar);
                inner.appendChild(textSpan);
                bubble.appendChild(inner);
            } else {
                bubble.textContent = text;
            }

            container.appendChild(bubble);
            container.scrollTop = container.scrollHeight;
        }

        // Typewriter-style rendering for assistant replies. The full text
        // already lives in JS memory by the time we call this — we're only
        // *painting* it slowly to mimic real LLM streaming. No backend
        // changes involved.
        //
        // Auto-scroll uses the standard "sticky bottom" pattern: we only
        // re-scroll to the bottom while the user is already within
        // STICK_THRESHOLD_PX of it. As soon as they scroll up to read
        // earlier content, we stop hijacking their scroll position.
        function streamMessageIntoBubble(container, text, onDone) {
            var DELAY_MS = 15;
            var STICK_THRESHOLD_PX = 50;

            var bubble = document.createElement('div');
            bubble.className = 'mcp-chatbot-msg assistant';

            // Build inner flex wrapper with text span + avatar
            var inner = document.createElement('div');
            inner.className = 'mcp-assistant-inner';

            var textSpan = document.createElement('span');
            textSpan.className = 'mcp-assistant-text';

            var avatar = document.createElement('img');
            avatar.className = 'mcp-assistant-avatar';
            var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
            avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/chat-bot-logo.png';
            avatar.alt = '';

            inner.appendChild(avatar);
            inner.appendChild(textSpan);
            bubble.appendChild(inner);

            var initialDistance =
                container.scrollHeight - container.scrollTop - container.clientHeight;
            var wasStickyOnEntry = initialDistance < STICK_THRESHOLD_PX;

            container.appendChild(bubble);
            if (wasStickyOnEntry) {
                container.scrollTop = container.scrollHeight;
            }

            var i = 0;

            function tick() {
                if (i >= text.length) {
                    if (onDone) { onDone(); }
                    return;
                }
                var distanceFromBottom =
                    container.scrollHeight - container.scrollTop - container.clientHeight;
                var wasStickyToBottom = distanceFromBottom < STICK_THRESHOLD_PX;

                textSpan.textContent += text.charAt(i);
                i++;

                if (wasStickyToBottom) {
                    container.scrollTop = container.scrollHeight;
                }
                setTimeout(tick, DELAY_MS);
            }
            tick();
        }

        function showTyping(container) {
            var indicator = document.createElement('div');
            indicator.className = 'mcp-chatbot-msg assistant typing';

            var inner = document.createElement('div');
            inner.className = 'mcp-assistant-inner';

            var avatar = document.createElement('img');
            avatar.className = 'mcp-assistant-avatar';
            var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
            avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/chat-bot-logo.png';
            avatar.alt = '';

            var textSpan = document.createElement('span');
            textSpan.className = 'mcp-assistant-text';
            textSpan.textContent = 'Thinking...';

            inner.appendChild(avatar);
            inner.appendChild(textSpan);
            indicator.appendChild(inner);

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
            var wrapperEl = document.querySelector('.mcp-chatbot-input-wrapper');

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
                if (wrapperEl) { wrapperEl.classList.add('disabled'); }
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
                if (wrapperEl) { wrapperEl.classList.remove('disabled'); }
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
                bubble.classList.add('d-none');
                isOpen = true;
                sessionStorage.setItem(OPEN_KEY, '1');
                if (bubble) { bubble.classList.remove('mcp-bubble-hovered'); }
                // Only refetch history when the message area is empty
                // (first open of the tab, or after an explicit end-session).
                // If there is already DOM content, it means the user just
                // minimised — keep it as-is. Refetching here would race the
                // in-flight /message transaction (READ COMMITTED can't see
                // the not-yet-committed user row), causing the user's
                // message to vanish until the next open cycle.
                if (msgArea.children.length === 0) {
                    loadHistoryFromBackend(sessionToken, msgArea, function (hasSession) {
                        setEndSessionVisible(hasSession);
                        input.focus();
                    });
                } else {
                    input.focus();
                }
            }

            function closeWindow() {
                chatWin.classList.add('d-none');
                bubble.classList.remove('d-none');
                isOpen = false;
                sessionStorage.setItem(OPEN_KEY, '0');
                // Do NOT wipe msgArea here. The widget is just hidden via
                // d-none — keeping the DOM intact means a mid-stream reply
                // continues painting into the (hidden) bubble and the user
                // sees the full conversation when they reopen, with no race
                // against the in-flight backend transaction.
            }

            bubble.addEventListener('click', function () {
                isOpen ? closeWindow() : openWindow();
            });

            if (closeBtn) {
                closeBtn.addEventListener('click', closeWindow);
            }

            // ── End session (with confirmation + rating) ─────────────                                    
            var selectedRating = null;                                                                      
            var faceBtns = confirmOverlay                                                                   
                ? confirmOverlay.querySelectorAll('.mcp-chatbot-face')                                      
                : [];                                                                                       
            var feedbackArea = confirmOverlay                                                               
                ? confirmOverlay.querySelector('.mcp-chatbot-feedback')                                     
                : null;                                                                                     
                                                                                                            
            faceBtns.forEach(function (btn) {                                                               
                btn.addEventListener('click', function () {                                                 
                    faceBtns.forEach(function (b) { b.classList.remove('selected'); });                     
                    btn.classList.add('selected');                                                          
                    selectedRating = btn.getAttribute('data-rating');                         
                });                                                                                         
            });
            
            if (endSessionBtn && confirmOverlay) {
                endSessionBtn.addEventListener('click', function () {
                    // Reset state each time the dialog opens                                               
                    selectedRating = null;                                                                  
                    faceBtns.forEach(function (b) { b.classList.remove('selected'); });                     
                    if (feedbackArea) { feedbackArea.value = ''; }
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
                    if (selectedRating !== null) {                                                          
                        payload.rating = selectedRating;                                                    
                    }                                                                                       
                    if (feedbackArea && feedbackArea.value.trim()) {                                        
                        payload.feedback = feedbackArea.value.trim();                                       
                    }  
                    jsonRpc('/mcp_chatbot/close', payload)
                        .then(function () {
                            setEndSessionVisible(false);
                            clearSessionToken();
                            sessionToken = getSessionToken();
                            chatWin.classList.add('d-none');
                            bubble.classList.remove('d-none');
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
                // Re-entrancy guard. The send button stays disabled from
                // the moment a request is fired until the typewriter has
                // finished painting the reply, so any second click OR any
                // Enter-keypress during that window is dropped here. The
                // input itself stays editable so the user can read, edit
                // and even type their next message ahead of time — same
                // UX we had before the streaming feature, when only the
                // send button was locked while "Thinking..." was visible.
                //
                // This also covers the offline case: updateStatus('offline')
                // disables the send button, so sendMessage() short-circuits
                // here without us having to special-case it.
                if (sendBtn.disabled) { return; }

                var text = input.value.trim();
                if (!text) { return; }

                appendMessage(msgArea, 'user', text);
                input.value = '';
                sendBtn.disabled = true;
                // Input was just cleared, so updateSendVisibility() will
                // hide the button. If the user starts typing again while
                // the bot is still thinking, the `input` listener will
                // re-show the button — it stays disabled (greyed-out)
                // until the reply finishes painting, so the click is a
                // no-op but the user gets visual feedback that their
                // next message is ready to send.
                updateSendVisibility();

                // Show typing indicator immediately. Summarisation now runs
                // in a background thread on the server, so the request path
                // is fast and there is no need to artificially delay the
                // typing dots. The "compacting" bar is shown afterwards
                // based on the backend's `compacting` flag.
                var typingEl = showTyping(msgArea);

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

                function unlockSend() {
                    sendBtn.disabled = false;
                    updateSendVisibility();
                    input.focus();
                }

                jsonRpc('/mcp_chatbot/message', payload)
                    .then(function (result) {
                        if (typingEl) { typingEl.remove(); typingEl = null; }
                        // Unlock only AFTER the typewriter finishes painting
                        // the reply, so the user cannot fire a follow-up
                        // mid-stream.
                        streamMessageIntoBubble(
                            msgArea,
                            result && result.reply
                                ? result.reply
                                : 'Sorry, I could not get a reply.',
                            unlockSend
                        );
                        setEndSessionVisible(true);   // session now exists
                        // Backend tells us when it kicked off a background
                        // summarisation. Show the bar as a non-blocking
                        // status hint after the reply has already landed.
                        if (result && result.compacting) {
                            showCompactingBar(msgArea);
                        }
                    })
                    .catch(function (err) {
                        if (typingEl) { typingEl.remove(); typingEl = null; }
                        appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.');
                        console.error('[mcp_chatbot] RPC error:', err);
                        // Error path: no streaming, so unlock immediately.
                        unlockSend();
                    });
            }

            sendBtn.addEventListener('click', sendMessage);

            // ── Send button visibility (hide when input is empty) ─────
            function updateSendVisibility() {
                // Visibility tracks the input text, not the disabled
                // state. While a request is in flight the button stays
                // `disabled` (greyed-out via the :disabled CSS rule) but
                // still appears as soon as the user types something, so
                // they get clear feedback that their next message is
                // queued up and ready to send once the bot finishes.
                // The re-entrancy guard inside sendMessage() keeps the
                // click itself a no-op.
                if (input.value.trim().length > 0) {
                    sendBtn.classList.remove('mcp-send-hidden');
                } else {
                    sendBtn.classList.add('mcp-send-hidden');
                }
            }
            // Start hidden
            sendBtn.classList.add('mcp-send-hidden');
            input.addEventListener('input', updateSendVisibility);

            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    // Always preventDefault to suppress any default Enter
                    // behaviour (form submit, newline insertion). The
                    // re-entrancy guard inside sendMessage() handles the
                    // "still in flight" case — pressing Enter while the
                    // bot is replying is a silent no-op.
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