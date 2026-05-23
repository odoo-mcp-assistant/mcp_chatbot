/**
 * chatbot_widget.js — UI state and event wiring
 *
 * Depends on:
 *   window.McpChatbotAPI    (chatbot_api.js)
 *   window.McpChatbotRender (chatbot_render.js)
 *
 * Load order in web.assets_frontend:
 *   1. chatbot_api.js       ← network / auth layer
 *   2. chatbot_render.js    ← markdown + DOM helpers
 *   3. chatbot_widget.js    ← THIS file: user-facing controller
 *
 * What this file does:
 *   - Wires every DOM event (click, keydown, scroll) to a handler.
 *   - Decides WHEN to call FastAPI endpoints (/info, /history,
 *     /message, /close) via the API.apiRequest helper.
 *   - Manages UI state (open/closed bubble, expanded layout, typing
 *     indicator, end-session overlay, etc.).
 *
 * Design decisions:
 *
 * 1. The session token is stored in sessionStorage (not localStorage).
 *    sessionStorage is cleared automatically when the browser tab is
 *    closed or when the user logs out (Odoo invalidates the session).
 *    This prevents cross-user contamination entirely.
 *
 * 2. For logged-in users, no token is stored. The session is identified
 *    by the partner_id provided by the backend (and embedded in the JWT).
 *
 * 3. Chat history is fetched from the backend on every widget open,
 *    not stored in the browser. The browser only stores the token
 *    for anonymous users.
 *
 * 4. If the backend session is closed (cron) or not found, the token
 *    is wiped and a fresh one is generated automatically for anonymous users.
 */

// IIFE — keeps every helper private; nothing is exported to window.
// The widget is a pure consumer of McpChatbotAPI / McpChatbotRender.
(function () {
    'use strict';

    // Local aliases for the two globals exported by the other JS files.
    // Shortens the call sites (API.apiRequest vs window.McpChatbotAPI.apiRequest).
    var API    = window.McpChatbotAPI;
    var Render = window.McpChatbotRender;

    // ──────────────────────────────────────────────────────────────
    // Load history from backend
    // ──────────────────────────────────────────────────────────────
    // Called when the bubble is opened for the first time in the tab.
    // Two purposes:
    //   1. Replay any messages from a session that was started earlier
    //      (e.g. user refreshed the page, navigated to another page).
    //   2. Detect a server-side session close (idle-timeout cron, manual
    //      end-session) and rotate the anonymous identity if needed.
    //
    // - container : the <div> where message bubbles are appended
    // - callback  : invoked with `true` if a live session was found
    //               (so the End-Session button can be shown), `false`
    //               otherwise
    function loadHistoryFromBackend(container, callback) {
        // GET /mcp_chatbot/history — no body, just the JWT in the header.
        API.apiRequest('/mcp_chatbot/history', null, 'GET')
            .then(function (result) {
                // Server tells us the session no longer exists. This is
                // NOT an HTTP error (status 200), it's a normal payload
                // with status === 'closed' or 'not_found'.
                if (!result || result.status === 'closed' || result.status === 'not_found') {
                    API.handleSessionGone();          // rotate anon UUID + re-mint JWT
                    container.innerHTML = '';
                    Render.renderHero(container);     // show the empty-state greeting
                    if (callback) { callback(false); }
                    return;
                }

                var messages = result.messages || [];
                container.innerHTML = '';   // wipe any placeholder before replaying

                if (messages.length === 0) {
                    // Live session but no messages yet → still show the hero.
                    Render.renderHero(container);
                    if (callback) { callback(false); }
                } else {
                    // Replay each persisted message in order.
                    messages.forEach(function (msg) {
                        Render.appendMessage(container, msg.role, msg.content);
                    });
                    if (callback) { callback(true); }
                }
            })
            .catch(function () {
                // Network failure / unparseable response → just render
                // the hero so the user isn't stuck on an empty screen.
                Render.renderHero(container);
                if (callback) { callback(false); }
            });
    }

    // ──────────────────────────────────────────────────────────────
    // Header + status helpers
    // ──────────────────────────────────────────────────────────────

    // Replaces the placeholder "AI Assistant" text in three places:
    // the header title, the bubble tooltip, and the disclaimer line.
    // Called after GET /info resolves with `bot_name`.
    function updateHeaderName(name) {
        var titleEl = document.getElementById('mcp_chatbot_title');
        if (titleEl && name) { titleEl.textContent = name; }
        var tooltipNameEl = document.getElementById('mcp_chatbot_tooltip_name');
        if (tooltipNameEl && name) { tooltipNameEl.textContent = name; }
        var disclaimerNameEl = document.getElementById('mcp_chatbot_disclaimer_name');
        if (disclaimerNameEl && name) { disclaimerNameEl.textContent = name; }
    }

    // Toggles the "Online" / "Offline" badge and disables the input
    // when the backend reports the chatbot is offline. Called once
    // on page load via GET /info.
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
            if (sendEl)    { sendEl.disabled = true; }
            if (wrapperEl) { wrapperEl.classList.add('disabled'); }
        } else {
            if (statusEl) {
                statusEl.textContent = 'Online';
                statusEl.classList.add('mcp-status-online');
                statusEl.classList.remove('mcp-status-offline');
            }
            if (inputEl) {
                inputEl.disabled    = false;
                inputEl.placeholder = 'Ask AI anything...';
            }
            if (sendEl)    { sendEl.disabled = false; }
            if (wrapperEl) { wrapperEl.classList.remove('disabled'); }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GET /info — runs immediately at script-load time
    // ──────────────────────────────────────────────────────────────
    // Fetched once per page load to populate:
    //   - the header title and bubble tooltip (bot_name),
    //   - the Online/Offline status badge,
    //   - the hero greeting identity (auth state + first name).
    // Failure is silent on purpose: HTML defaults ("AI Assistant",
    // "Online") stay visible so the widget remains usable.
    API.apiRequest('/mcp_chatbot/info', null, 'GET')
        .then(function (result) {
            if (!result) { return; }
            if (result.bot_name) { updateHeaderName(result.bot_name); }
            if (result.status)   { updateStatus(result.status); }
            // Identity drives the greeting copy (e.g. "Good morning, Mohamed").
            // Stored in the Render module so renderHero() can read it later.
            Render.setHeroIdentity({
                isAuthenticated: !!result.is_authenticated,
                firstName:       result.first_name || '',
            });
            // If the hero is already visible with a placeholder name,
            // re-render it now that we know who the user is.
            var msgArea = document.getElementById('mcp_chatbot_messages');
            if (msgArea && msgArea.querySelector('#mcp_chatbot_hero')) {
                Render.renderHero(msgArea);
            }
        })
        .catch(function () {});  // silent — fallbacks stay as "AI Assistant" / "Online"

    // ──────────────────────────────────────────────────────────────
    // Widget initialisation
    // ──────────────────────────────────────────────────────────────
    // Runs once on DOMContentLoaded. Grabs every DOM node the widget
    // touches and wires all the event listeners. After this function
    // returns, the widget is entirely event-driven.
    function initChatbot() {
        // Guard against double-init (e.g. if both DOMContentLoaded and
        // a hot-reload trigger fire). The flag lives on `window` so it
        // persists across IIFE re-executions during dev.
        if (window.__mcpChatbotInit) { return; }
        window.__mcpChatbotInit = true;

        // ── Resolve every DOM node we will need ───────────────────
        var bubble        = document.getElementById('mcp_chatbot_bubble');
        var bubbleTooltip = document.getElementById('mcp_chatbot_bubble_tooltip');
        var chatWin       = document.getElementById('mcp_chatbot_window');
        var closeBtn      = chatWin && chatWin.querySelector('.mcp-chatbot-close');
        var expandBtn     = chatWin && chatWin.querySelector('.mcp-chatbot-expand');
        var endSessionBtn = chatWin && chatWin.querySelector('.mcp-chatbot-end-session');
        var confirmOverlay = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-overlay');
        var confirmYes    = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-yes');
        var confirmNo     = chatWin && chatWin.querySelector('.mcp-chatbot-confirm-no');
        var msgArea       = document.getElementById('mcp_chatbot_messages');
        var input         = document.getElementById('mcp_chatbot_input');
        var sendBtn       = document.getElementById('mcp_chatbot_send');
        var scrollBottomBtn = document.getElementById('mcp_chatbot_scroll_bottom');

        // The widget template might not be on this page (the chatbot
        // is only injected via snippet_template.xml). Bail silently
        // if the core nodes are missing.
        if (!bubble || !chatWin || !msgArea || !input || !sendBtn) { return; }

        // Portal the chatbot's fixed UI out of #wrapwrap so that when
        // the open-state class shrinks #wrapwrap (to push page content
        // left, VSCode-Copilot-style) the panel itself stays anchored
        // to the real viewport instead of shrinking with the page.
        [bubble, bubbleTooltip, chatWin].forEach(function (el) {
            if (el && el.parentNode !== document.body) {
                document.body.appendChild(el);
            }
        });

        // Remember across page navigations whether the bubble was open
        // when the user left the previous page. Set/cleared via the
        // OPEN_KEY in sessionStorage (key name exported by chatbot_api.js).
        var isOpen = sessionStorage.getItem(API.OPEN_KEY) === '1';

        // Incremented on every end-session so in-flight message callbacks
        // from the previous session are silently dropped. Each sendMessage()
        // call captures the current value into `myGen`; if `sessionGen`
        // has moved on by the time the response lands, the callback bails.
        var sessionGen = 0;

        // ── Scroll-to-bottom button ───────────────────────────────
        // Floating arrow shown when the user has scrolled up away from
        // the bottom of the message list. Lets them jump back to the
        // latest message in one click.
        var SCROLL_THRESHOLD_PX = 60;
        function updateScrollBtn() {
            if (!scrollBottomBtn) { return; }
            var dist = msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight;
            if (dist > SCROLL_THRESHOLD_PX) {
                scrollBottomBtn.classList.remove('d-none');
            } else {
                scrollBottomBtn.classList.add('d-none');
            }
        }
        if (scrollBottomBtn) {
            msgArea.addEventListener('scroll', updateScrollBtn);
            scrollBottomBtn.addEventListener('click', function () {
                msgArea.scrollTo({ top: msgArea.scrollHeight, behavior: 'smooth' });
            });
        }

        // ── Bubble tooltip hover ──────────────────────────────────
        // Adds a CSS class while the user hovers the floating bubble
        // so a "Chat with us" tooltip slides in. Suppressed while the
        // chat window is open (no point hovering what is already open).
        if (bubble && bubbleTooltip) {
            bubble.addEventListener('mouseenter', function () {
                if (!isOpen) { bubble.classList.add('mcp-bubble-hovered'); }
            });
            bubble.addEventListener('mouseleave', function () {
                bubble.classList.remove('mcp-bubble-hovered');
            });
        }

        // ── End-session button visibility ─────────────────────────
        // Only relevant when a live backend session exists; hidden
        // otherwise so the user can't "end" a session that isn't there.
        function setEndSessionVisible(visible) {
            if (!endSessionBtn) { return; }
            if (visible) {
                endSessionBtn.classList.remove('d-none');
            } else {
                endSessionBtn.classList.add('d-none');
            }
        }
        setEndSessionVisible(false);

        // ── Open / close ──────────────────────────────────────────
        // openWindow() is the entry point that decides whether to call
        // GET /history. closeWindow() only toggles classes — no network.
        function openWindow() {
            chatWin.classList.remove('d-none');
            bubble.classList.add('d-none');
            document.body.classList.add('mcp-chatbot-open');
            isOpen = true;
            sessionStorage.setItem(API.OPEN_KEY, '1');
            if (bubble) { bubble.classList.remove('mcp-bubble-hovered'); }
            // Only refetch history when the message area is empty
            // (first open of the tab, or after an explicit end-session).
            // Reopening a previously-open bubble keeps the in-memory DOM.
            if (msgArea.children.length === 0) {
                loadHistoryFromBackend(msgArea, function (hasSession) {
                    setEndSessionVisible(hasSession);
                    updateScrollBtn();
                    input.focus();
                });
            } else {
                input.focus();
            }
        }

        function closeWindow() {
            chatWin.classList.add('d-none');
            bubble.classList.remove('d-none');
            document.body.classList.remove('mcp-chatbot-open');
            document.body.classList.remove('mcp-chatbot-expanded');
            isOpen = false;
            isExpanded = false;
            if (expandBtn) {
                expandBtn.title = 'Expand';
                expandBtn.querySelector('i').className = 'fa fa-expand';
            }
            sessionStorage.setItem(API.OPEN_KEY, '0');
            // Do NOT wipe msgArea here — keeping the DOM intact means a
            // mid-stream reply continues painting into the hidden bubble
            // and the user sees the full conversation when they reopen.
        }

        // Click on the floating bubble toggles the window open/closed.
        bubble.addEventListener('click', function () {
            isOpen ? closeWindow() : openWindow();
        });

        // Top-right "X" button just closes; never calls any endpoint.
        if (closeBtn) {
            closeBtn.addEventListener('click', closeWindow);
        }

        // ── Expand / collapse to 50% width ───────────────────────
        // Toggles a CSS class on <body> for the Copilot-style wide
        // layout. Pure CSS — no network call, no DOM manipulation
        // beyond swapping the icon (fa-expand ↔ fa-compress).
        var isExpanded = false;
        if (expandBtn) {
            expandBtn.addEventListener('click', function () {
                isExpanded = !isExpanded;
                if (isExpanded) {
                    document.body.classList.add('mcp-chatbot-expanded');
                    expandBtn.title = 'Collapse';
                    expandBtn.querySelector('i').className = 'fa fa-compress';
                } else {
                    document.body.classList.remove('mcp-chatbot-expanded');
                    expandBtn.title = 'Expand';
                    expandBtn.querySelector('i').className = 'fa fa-expand';
                }
            });
        }

        // ── End session (with confirmation + rating) ─────────────
        // Flow:
        //   1. User clicks "End session" → confirm overlay appears.
        //   2. User optionally picks a face (rating) and types feedback.
        //   3. User clicks "Yes" → POST /mcp_chatbot/close with the
        //      rating + feedback, then rotate the anon identity.
        //   4. User clicks "No"  → overlay is dismissed, nothing else.
        var selectedRating = null;
        var faceBtns = confirmOverlay
            ? confirmOverlay.querySelectorAll('.mcp-chatbot-face')
            : [];
        var feedbackArea = confirmOverlay
            ? confirmOverlay.querySelector('.mcp-chatbot-feedback')
            : null;

        // Single-selection radio behaviour for the emoji faces.
        faceBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                faceBtns.forEach(function (b) { b.classList.remove('selected'); });
                btn.classList.add('selected');
                selectedRating = btn.getAttribute('data-rating');
            });
        });

        if (endSessionBtn && confirmOverlay) {
            // Open the overlay — reset previous rating/feedback first.
            endSessionBtn.addEventListener('click', function () {
                selectedRating = null;
                faceBtns.forEach(function (b) { b.classList.remove('selected'); });
                if (feedbackArea) { feedbackArea.value = ''; }
                confirmOverlay.classList.remove('d-none');
            });

            // "No" just closes the overlay.
            confirmNo.addEventListener('click', function () {
                confirmOverlay.classList.add('d-none');
            });

            // "Yes" — actually end the session.
            confirmYes.addEventListener('click', function () {
                confirmOverlay.classList.add('d-none');
                // Bump generation so any reply still streaming from a
                // previous /message call is dropped on arrival.
                sessionGen++;
                sendBtn.disabled = false;
                updateSendVisibility();
                // Build the payload — both fields are optional.
                var payload = {};
                if (selectedRating !== null) {
                    payload.rating = selectedRating;
                }
                if (feedbackArea && feedbackArea.value.trim()) {
                    payload.feedback = feedbackArea.value.trim();
                }
                // POST /mcp_chatbot/close — closes the session server-side.
                API.apiRequest('/mcp_chatbot/close', payload)
                    .then(function () {
                        setEndSessionVisible(false);
                        // Rotate the anon UUID + re-mint JWT so the
                        // next message starts a fresh session row.
                        API.handleSessionGone();
                        // Reset all UI state to "fresh page" appearance.
                        chatWin.classList.add('d-none');
                        bubble.classList.remove('d-none');
                        document.body.classList.remove('mcp-chatbot-open');
                        document.body.classList.remove('mcp-chatbot-expanded');
                        isOpen = false;
                        isExpanded = false;
                        if (expandBtn) {
                            expandBtn.title = 'Expand';
                            expandBtn.querySelector('i').className = 'fa fa-expand';
                        }
                        sessionStorage.setItem(API.OPEN_KEY, '0');
                        msgArea.innerHTML = '';
                        updateScrollBtn();
                    })
                    .catch(function (err) {
                        console.error('[mcp_chatbot] Failed to close session:', err);
                    });
            });
        }

        // If the previous page had the bubble open, reopen it now.
        // Triggers GET /history because msgArea is empty on fresh load.
        if (isOpen) {
            openWindow();
        }

        // ── Send message ──────────────────────────────────────────
        // The main user action. Sequence:
        //   1. Validate (non-empty, send button not already disabled).
        //   2. Optimistically append the user bubble.
        //   3. Disable the send button (re-entrancy guard).
        //   4. Show the "Thinking..." typing indicator.
        //   5. POST /mcp_chatbot/message with { message: text }.
        //   6. On response → remove the indicator, stream the reply
        //      word-by-word, re-enable send when streaming finishes.
        function sendMessage() {
            // Re-entrancy guard — send button stays disabled from the moment
            // a request fires until the typewriter finishes painting the reply.
            if (sendBtn.disabled) { return; }

            var text = input.value.trim();
            if (!text) { return; }

            // First user message in this view → remove the hero greeting.
            Render.removeHero(msgArea);

            // Optimistic UI: show the user's bubble before the network call.
            Render.appendMessage(msgArea, 'user', text);
            input.value = '';
            autoResizeInput();
            sendBtn.disabled = true;
            updateSendVisibility();

            // "Thinking..." bubble — replaced by the real reply later.
            var typingEl = Render.showTyping(msgArea);

            // Re-enables the send button once the reply animation finishes.
            // Passed as a callback to streamMessageIntoBubble so the button
            // stays disabled for the entire reply animation, not just the
            // HTTP round-trip.
            function unlockSend() {
                sendBtn.disabled = false;
                updateSendVisibility();
                input.focus();
            }

            // Snapshot the session generation. If end-session is clicked
            // mid-request, sessionGen will be bumped and our callbacks
            // will detect the mismatch and silently return.
            var myGen = sessionGen;
            API.apiRequest('/mcp_chatbot/message', { message: text })
                .then(function (result) {
                    if (sessionGen !== myGen) { return; }   // stale-reply guard
                    if (typingEl) { typingEl.remove(); typingEl = null; }

                    var replyText = result && result.reply
                        ? result.reply
                        : 'Sorry, I could not get a reply.';

                    if (result && result.summarized) {
                        // Server compacted the conversation history this
                        // round — show a 5-second progress bar before the
                        // reply, so the small latency feels intentional.
                        Render.showCompactingBar(msgArea);
                        setTimeout(function () {
                            Render.streamMessageIntoBubble(msgArea, replyText, unlockSend);
                            setEndSessionVisible(true);
                        }, 5000);
                    } else {
                        // Normal path — stream the reply immediately.
                        Render.streamMessageIntoBubble(msgArea, replyText, unlockSend);
                        setEndSessionVisible(true);
                    }
                })
                .catch(function (err) {
                    if (sessionGen !== myGen) { return; }   // stale-error guard
                    console.error('[mcp_chatbot] RPC error:', err);
                    if (typingEl) { typingEl.remove(); }
                    Render.appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.');
                    unlockSend();
                });
        }

        sendBtn.addEventListener('click', sendMessage);

        // ── Suggestion chips ──────────────────────────────────────
        // Pre-baked example queries below the hero. Clicking a chip
        // prefills the input and immediately triggers sendMessage() —
        // same endpoint as a typed message, just with a canned prompt.
        document.querySelectorAll('.mcp-chatbot-suggestion').forEach(function (chip) {
            chip.addEventListener('click', function () {
                if (sendBtn.disabled) { return; }
                var query = chip.getAttribute('data-query') || chip.textContent.trim();
                input.value = query;
                updateSendVisibility();
                sendMessage();
            });
        });

        // Capabilities badge is rendered dynamically inside the hero,
        // so we delegate the click from the message container (event
        // delegation — the badge node might not exist yet at wiring time).
        msgArea.addEventListener('click', function (e) {
            var badge = e.target.closest && e.target.closest('.mcp-chatbot-capabilities');
            if (!badge || sendBtn.disabled) { return; }
            var query = badge.getAttribute('data-query') || badge.textContent.trim();
            input.value = query;
            updateSendVisibility();
            sendMessage();
        });

        // ── Send button visibility (hidden when input is empty) ───
        // Cosmetic toggle — keeps the send button hidden until the user
        // has actually typed something, then fades it in.
        function updateSendVisibility() {
            if (input.value.trim().length > 0) {
                sendBtn.classList.remove('mcp-send-hidden');
            } else {
                sendBtn.classList.add('mcp-send-hidden');
            }
        }
        sendBtn.classList.add('mcp-send-hidden');
        input.addEventListener('input', updateSendVisibility);

        // ── Auto-resize the textarea, capped at 2 lines ───────────
        // Grows the textarea as the user types, but stops at `max` so
        // long messages scroll internally instead of pushing the layout.
        function autoResizeInput() {
            input.style.height = 'auto';
            var sh = input.scrollHeight;
            // Bail if hidden (scrollHeight is 0) — otherwise we'd pin
            // height: 0px and collapse the textarea once it becomes visible.
            if (!sh) { return; }
            var max = 88; // keep in sync with .mcp-chatbot-input max-height
            input.style.height = Math.min(sh, max) + 'px';
        }
        autoResizeInput();
        input.addEventListener('input', autoResizeInput);

        // Enter sends the message; Shift+Enter inserts a newline (the
        // default textarea behaviour, which we keep by NOT calling
        // preventDefault when Shift is held).
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
                autoResizeInput();
            }
        });
    }

    // ──────────────────────────────────────────────────────────────
    // Bootstrap
    // ──────────────────────────────────────────────────────────────
    // Run initChatbot once the DOM is ready. If the document is still
    // parsing, wait for DOMContentLoaded; otherwise call immediately.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatbot);
    } else {
        initChatbot();
    }

})();
