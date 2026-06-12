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

    // Chatbot availability as reported by GET /info. Starts as null (= not
    // known yet) and is only ever set from the backend's answer. sendMessage()
    // hard-gates on this being exactly 'online' — so no message request can
    // leave the browser while the status is offline OR simply not loaded yet
    // (slow or failed /info). Disabling the composer in updateStatus() is
    // cosmetic; this flag is the actual gate.
    var botStatus = null;

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
        var micEl     = document.getElementById('mcp_chatbot_mic');
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
            if (micEl)     { micEl.disabled = true; }
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
            if (micEl)     { micEl.disabled = false; }
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
            // The only place botStatus is ever written — straight from the
            // backend's answer. Anything other than 'online' keeps sending
            // blocked.
            botStatus = result.status || null;
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
        var micBtn        = document.getElementById('mcp_chatbot_mic');
        var scrollBottomBtn = document.getElementById('mcp_chatbot_scroll_bottom');

        // Conversations sidebar (logged-in, read-only history) nodes.
        var historyBtn      = chatWin && chatWin.querySelector('.mcp-chatbot-history');
        var sidebar         = document.getElementById('mcp_chatbot_sidebar');
        var sidebarClose    = chatWin && chatWin.querySelector('.mcp-chatbot-sidebar-close');
        var sidebarBackdrop = document.getElementById('mcp_chatbot_sidebar_backdrop');
        var convoList       = document.getElementById('mcp_chatbot_conversations');
        var readonlyBar     = document.getElementById('mcp_chatbot_readonly_bar');
        var backCurrentBtn  = chatWin && chatWin.querySelector('.mcp-chatbot-back-current');

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

        // True while the user is browsing a past conversation from the
        // sidebar. In this mode the composer is hidden (CSS, via the
        // .mcp-viewing-past class on the window) and the read-only footer
        // is shown instead — see enterPastView / exitPastView below.
        var viewingPast = false;

        // Id of the past session currently open in the read-only view, or
        // null when we're on the live session. Drives which sidebar row is
        // highlighted: the past one you're reading, or — on the live session —
        // the open/current row.
        var viewedSessionId = null;

        // Whether the user has a live (open) session. Refreshed every time the
        // sidebar list is rendered. Decides the read-only footer button: when
        // true it returns to that live chat, otherwise it starts a fresh one.
        var hasCurrentSession = false;

        // While the user browses a past conversation, the live chat's DOM
        // (its messages + any in-progress "Thinking…" indicator) is detached
        // into this fragment rather than destroyed, then re-attached on return
        // — so a reply that was mid-flight is never lost.
        var liveFragment = null;

        // Whether a /message reply is currently in flight, and the live
        // "Thinking…" indicator node it will replace. Tracked at widget scope
        // (not inside sendMessage) so the reply can be delivered to the live
        // view even after a detour through the history view.
        var livePending = false;
        var liveTypingEl = null;

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

        // ── Conversations sidebar (logged-in users, read-only) ───
        // The history button is hidden in the template by default; we
        // only reveal it once we know the caller is authenticated. The
        // partner_id comes from the signed JWT (see chatbot_api.js), so
        // anonymous visitors never see the button at all.
        var isAuthenticated = !!API.getPartnerId();
        if (isAuthenticated && historyBtn) {
            historyBtn.classList.remove('d-none');
        }

        // Map a session's creation time to a ChatGPT-style age bucket
        // (Today / Yesterday / Previous 7 days / Previous 30 days / Older).
        // Compares calendar days, not 24h windows, so "Yesterday" is correct
        // regardless of the time of day.
        function bucketLabel(iso) {
            if (!iso) { return 'Older'; }
            var d = new Date(iso);
            if (isNaN(d.getTime())) { return 'Older'; }
            var now = new Date();
            var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            var startThat  = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            var diffDays = Math.round((startToday - startThat) / 86400000);
            if (diffDays <= 0)  { return 'Today'; }
            if (diffDays === 1) { return 'Yesterday'; }
            if (diffDays <= 7)  { return 'Previous 7 days'; }
            if (diffDays <= 30) { return 'Previous 30 days'; }
            return 'Older';
        }

        // Compact "Mon D, HH:MM" label for the per-row meta line.
        function formatConvoDate(iso) {
            if (!iso) { return ''; }
            var d = new Date(iso);
            if (isNaN(d.getTime())) { return ''; }
            var date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
            var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return date + ', ' + time;
        }

        function showSidebar() {
            if (sidebar)         { sidebar.classList.remove('d-none'); }
            if (sidebarBackdrop) { sidebarBackdrop.classList.remove('d-none'); }
        }
        function hideSidebar() {
            if (sidebar)         { sidebar.classList.add('d-none'); }
            if (sidebarBackdrop) { sidebarBackdrop.classList.add('d-none'); }
        }

        // Build one clickable conversation row — title only, single line, flat
        // (no card chrome), like the major AI assistants. `isActive` highlights
        // the row the user is currently looking at (follows the open past
        // conversation, not always the live session).
        function buildConversationItem(convo, isActive) {
            var isCurrent = convo.state === 'open';

            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'mcp-conversation-item' + (isActive ? ' is-current' : '');

            var title = document.createElement('span');
            title.className = 'mcp-conversation-title';
            title.textContent = convo.title || 'New conversation';
            title.title = convo.title || '';   // native tooltip shows the full text
            item.appendChild(title);

            // Secondary line: date/time · total messages.
            var meta = document.createElement('span');
            meta.className = 'mcp-conversation-meta';
            var count = convo.message_count || 0;
            var parts = [];
            var when = formatConvoDate(convo.created_at);
            if (when) { parts.push(when); }
            parts.push(count + (count === 1 ? ' message' : ' messages'));
            meta.textContent = parts.join('  ·  ');
            item.appendChild(meta);

            item.addEventListener('click', function () {
                selectConversation(convo.id, isCurrent);
            });
            return item;
        }

        // Build a labelled section (header + its rows).
        function buildConversationSection(label, convos, activeId) {
            var section = document.createElement('div');
            section.className = 'mcp-conversation-section';

            var heading = document.createElement('div');
            heading.className = 'mcp-conversation-section-title';
            heading.textContent = label;
            section.appendChild(heading);

            convos.forEach(function (convo) {
                section.appendChild(buildConversationItem(convo, convo.id === activeId));
            });
            return section;
        }

        // Order the past-conversation time buckets are rendered in.
        var TIME_BUCKET_ORDER = [
            'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older',
        ];

        // Render the sidebar. The live (open) session, if any, sits in its own
        // "Current conversation" group at the top; the past conversations are
        // then split into time buckets (Today / Yesterday / Previous 7 days /
        // …), newest first — the layout the major AI assistants use. The
        // highlighted row follows whatever the user is actually viewing.
        function renderConversations(list) {
            if (!convoList) { return; }
            convoList.innerHTML = '';

            if (!list || list.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'mcp-conversations-empty';
                empty.textContent = 'No conversations yet.';
                convoList.appendChild(empty);
                return;
            }

            // FastAPI already sorts newest-first; split into live vs past.
            var open   = list.filter(function (c) { return c.state === 'open'; });
            var closed = list.filter(function (c) { return c.state !== 'open'; });

            // Remember whether a live session exists (drives the footer button).
            hasCurrentSession = open.length > 0;

            // Which row to highlight: the past one being read, else the live one.
            var activeId = viewingPast
                ? viewedSessionId
                : (open.length ? open[0].id : null);

            if (open.length) {
                convoList.appendChild(
                    buildConversationSection('Current conversation', open, activeId)
                );
            }

            // Bucket the past conversations by age. Insertion order within each
            // bucket is preserved, so rows stay newest-first.
            var buckets = {};
            closed.forEach(function (c) {
                var label = bucketLabel(c.created_at);
                (buckets[label] = buckets[label] || []).push(c);
            });
            TIME_BUCKET_ORDER.forEach(function (label) {
                if (buckets[label] && buckets[label].length) {
                    convoList.appendChild(
                        buildConversationSection(label, buckets[label], activeId)
                    );
                }
            });
        }

        // Open the drawer and (re)load the list from FastAPI every time, so
        // a conversation closed/rated since the last open is reflected.
        function openSidebar() {
            if (!convoList) { return; }
            showSidebar();
            convoList.innerHTML =
                '<div class="mcp-conversations-empty">Loading…</div>';
            API.apiRequest('/mcp_chatbot/conversations', null, 'GET')
                .then(function (result) {
                    renderConversations(result && result.conversations);
                })
                .catch(function (err) {
                    console.error('[mcp_chatbot] Failed to load conversations:', err);
                    convoList.innerHTML =
                        '<div class="mcp-conversations-empty">Couldn’t load your conversations.</div>';
                });
        }

        if (historyBtn) {
            historyBtn.addEventListener('click', openSidebar);
        }
        if (sidebarClose) {
            sidebarClose.addEventListener('click', hideSidebar);
        }
        if (sidebarBackdrop) {
            sidebarBackdrop.addEventListener('click', hideSidebar);
        }

        // Switch the window into read-only "viewing a past conversation" mode:
        // the .mcp-viewing-past class hides the composer/suggestions/disclaimer
        // (CSS) and we surface the read-only footer in their place.
        // Point the footer button at the right action/label: return to the
        // live chat when one exists, otherwise offer to start a fresh one.
        function updateBackButton() {
            if (!backCurrentBtn) { return; }
            var icon  = backCurrentBtn.querySelector('i');
            var label = backCurrentBtn.querySelector('.mcp-back-label');
            if (hasCurrentSession) {
                if (icon)  { icon.className = 'fa fa-arrow-left'; }
                if (label) { label.textContent = 'Back to current chat'; }
            } else {
                if (icon)  { icon.className = 'fa fa-plus'; }
                if (label) { label.textContent = 'Start a new chat'; }
            }
        }

        // Detach the entire live message area into liveFragment so it can be
        // restored byte-for-byte later (including a running thinking indicator).
        function captureLiveView() {
            liveFragment = document.createDocumentFragment();
            while (msgArea.firstChild) {
                liveFragment.appendChild(msgArea.firstChild);
            }
        }

        // The server sets usage_warning on the reply once a turn pushes the
        // caller past ~90% of their daily token budget. Shown as a toast once
        // per page load — not reset on end-session, because the budget is per
        // day per visitor, not per conversation.
        var usageWarningShown = false;

        // Deliver a completed /message reply. In the live view it streams in and
        // unlocks the composer; while browsing history it's added (static) to the
        // preserved fragment so it's already there when the user returns.
        function applyLiveReply(result) {
            livePending = false;
            var replyText = (result && result.reply)
                ? result.reply
                : 'Sorry, I could not get a reply.';

            if (result && result.usage_warning && !usageWarningShown) {
                usageWarningShown = true;
                showToast("You're approaching today's usage limit.", {
                    variant: 'warning',
                    duration: 10000,
                    dismissible: true,
                });
            }

            // Replace the thinking indicator wherever it currently lives.
            if (liveTypingEl) { liveTypingEl.remove(); liveTypingEl = null; }

            if (viewingPast) {
                // Off-screen: drop the reply into the detached live fragment.
                if (liveFragment) {
                    Render.appendMessage(liveFragment, 'assistant', replyText);
                }
                return;
            }

            function unlockSend() {
                sendBtn.disabled = false;
                updateSendVisibility();
                input.focus();
            }

            if (result && result.summarized) {
                // Server compacted history this round — show the 5s bar first.
                Render.showCompactingBar(msgArea);
                setTimeout(function () {
                    Render.streamMessageIntoBubble(msgArea, replyText, unlockSend);
                    setEndSessionVisible(true);
                }, 5000);
            } else {
                Render.streamMessageIntoBubble(msgArea, replyText, unlockSend);
                setEndSessionVisible(true);
            }
        }

        // Same idea for a failed request: surface the error in whichever view
        // is live, and unlock the composer when we're actually showing it.
        //
        // The server marks two limit conditions with a structured { code,
        // message }: a daily-budget block ("done for today") or a rate-limit
        // hit ("slow down"). Neither is part of the conversation, so we show
        // them as a transient toast (the same notice style as a denied
        // microphone permission) rather than a fake assistant bubble. Every
        // other failure still falls back to an inline assistant notice.
        function failLiveReply(err) {
            livePending = false;
            if (liveTypingEl) { liveTypingEl.remove(); liveTypingEl = null; }

            var KNOWN_LIMIT_CODES = ['daily_budget_exceeded', 'rate_limited'];
            var isLimit = err && KNOWN_LIMIT_CODES.indexOf(err.code) !== -1 && err.userMessage;

            if (isLimit) {
                showToast(err.userMessage, {
                    duration: 10000,
                    dismissible: true,
                });
            } else {
                var container = viewingPast ? liveFragment : msgArea;
                if (container) {
                    Render.appendMessage(container, 'assistant', 'An error occurred. Please try again.');
                }
            }

            if (!viewingPast) {
                sendBtn.disabled = false;
                updateSendVisibility();
                input.focus();
            }
        }

        function enterPastView() {
            viewingPast = true;
            chatWin.classList.add('mcp-viewing-past');
            // A past conversation always has messages — make sure the empty-state
            // (hero) layout isn't left on from the live view we just detached.
            Render.setEmptyState(false);
            updateBackButton();
            if (readonlyBar) { readonlyBar.classList.remove('d-none'); }
            setEndSessionVisible(false);   // can't end a session you're only viewing
        }

        // Leave read-only mode and restore the preserved live view. We re-attach
        // the exact DOM we detached on entry (messages + any in-progress
        // thinking indicator, or a reply that landed while we were away) instead
        // of reloading from the backend — so nothing in-flight is lost.
        function exitPastView() {
            viewingPast = false;
            viewedSessionId = null;
            chatWin.classList.remove('mcp-viewing-past');
            if (readonlyBar) { readonlyBar.classList.add('d-none'); }

            msgArea.innerHTML = '';
            if (liveFragment) {
                msgArea.appendChild(liveFragment);   // moves children back in
                liveFragment = null;
            }

            // If a reply is still in flight, keep the composer locked and let
            // the pending request unlock it when it lands; otherwise it's usable.
            sendBtn.disabled = livePending;
            updateSendVisibility();

            // No real messages in the restored live view → show the fresh-chat
            // hero. renderHero() also clears any stale restored hero node and
            // re-applies the empty-state layout; otherwise force it off.
            if (!msgArea.querySelector('.mcp-chatbot-msg')) {
                Render.renderHero(msgArea);
            } else {
                Render.setEmptyState(false);
            }
            // End-session only makes sense once a real exchange exists.
            setEndSessionVisible(!!msgArea.querySelector('.mcp-chatbot-msg'));
            updateScrollBtn();
            msgArea.scrollTop = msgArea.scrollHeight;
        }

        // Fetch and render one past conversation, read-only. The in-flight live
        // reply (if any) is NOT dropped — the live view is detached intact and
        // the reply keeps streaming/queuing against it in the background.
        function loadPastConversation(sessionId) {
            API.apiRequest('/mcp_chatbot/conversations/' + sessionId, null, 'GET')
                .then(function (result) {
                    if (!result || result.status !== 'ok') {
                        // Session vanished (e.g. deleted in Odoo) — refresh the list.
                        openSidebar();
                        return;
                    }
                    hideSidebar();
                    // Preserve the live view the first time we leave it. On
                    // subsequent past↔past switches it's already saved, so we
                    // just discard the previously shown past conversation.
                    if (!viewingPast) { captureLiveView(); }
                    msgArea.innerHTML = '';
                    (result.messages || []).forEach(function (msg) {
                        Render.appendMessage(msgArea, msg.role, msg.content);
                    });
                    viewedSessionId = sessionId;
                    enterPastView();
                    // Start at the top so reading flows from the beginning.
                    msgArea.scrollTop = 0;
                    updateScrollBtn();
                })
                .catch(function (err) {
                    console.error('[mcp_chatbot] Failed to load conversation:', err);
                    hideSidebar();
                });
        }

        // Row click dispatcher: the live session returns you to the chat,
        // any other row opens read-only.
        function selectConversation(sessionId, isCurrent) {
            if (isCurrent) {
                if (viewingPast) { exitPastView(); }
                hideSidebar();
                return;
            }
            loadPastConversation(sessionId);
        }

        if (backCurrentBtn) {
            backCurrentBtn.addEventListener('click', exitPastView);
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
                // The dropped reply will never reach applyLiveReply, so clear
                // the pending-state it would otherwise have reset.
                livePending = false;
                liveTypingEl = null;
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

            // Availability gate — nothing is sent to FastAPI unless GET /info
            // confirmed the chatbot is online. Blocks both the offline state
            // (where the composer is disabled anyway) and the window where
            // /info hasn't answered yet but the HTML defaults left the
            // composer enabled. Checked BEFORE the optimistic UI paint so a
            // blocked send leaves no half-drawn user bubble behind.
            if (botStatus !== 'online') {
                showToast('Chat is unavailable right now. Please try again in a moment.');
                return;
            }

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

            // "Thinking..." indicator — tracked at widget scope (liveTypingEl)
            // so it survives a detour into the history view and is replaced by
            // the reply wherever the live view happens to be at that point.
            liveTypingEl = Render.showTyping(msgArea);
            livePending = true;

            // Snapshot the session generation. If end-session is clicked
            // mid-request, sessionGen is bumped and the callbacks below bail.
            // Browsing history does NOT bump it — the reply stays valid and is
            // delivered to the (detached) live view via applyLiveReply.
            var myGen = sessionGen;
            API.apiRequest('/mcp_chatbot/message', { message: text })
                .then(function (result) {
                    if (sessionGen !== myGen) { return; }   // session ended → drop
                    applyLiveReply(result);
                })
                .catch(function (err) {
                    if (sessionGen !== myGen) { return; }   // session ended → drop
                    console.error('[mcp_chatbot] RPC error:', err);
                    failLiveReply(err);
                });
        }

        sendBtn.addEventListener('click', sendMessage);

        // ── Transient toast (non-blocking notices) ────────────────
        // A small auto-dismissing banner anchored above the input, used
        // for things the user should see but that shouldn't interrupt the
        // chat (e.g. "Microphone access denied"). Only one shows at a time:
        // a new toast replaces the current one.
        //
        // opts (all optional):
        //   variant:     'warning' → amber icon instead of the danger red
        //   duration:    ms before auto-dismiss (default 3500)
        //   dismissible: true → adds an X button to close it early
        var toastTimer = null;
        function hideToast(toast) {
            toast.classList.remove('mcp-toast-show');
            // Remove after the fade-out finishes (matches CSS transition).
            setTimeout(function () { toast.remove(); }, 200);
        }
        function showToast(message, opts) {
            opts = opts || {};
            var existing = chatWin.querySelector('.mcp-chatbot-toast');
            if (existing) { existing.remove(); }
            if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

            var toast = document.createElement('div');
            toast.className = 'mcp-chatbot-toast';
            if (opts.variant === 'warning') {
                toast.classList.add('mcp-toast-warning');
            }
            var icon = document.createElement('i');
            icon.className = opts.variant === 'warning'
                ? 'fa fa-exclamation-triangle'
                : 'fa fa-exclamation-circle';
            toast.appendChild(icon);
            var span = document.createElement('span');
            span.textContent = message;
            toast.appendChild(span);

            if (opts.dismissible) {
                // The base toast is click-through (pointer-events: none); the
                // dismissible class re-enables clicks so the X works.
                toast.classList.add('mcp-toast-dismissible');
                var closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'mcp-toast-close';
                closeBtn.setAttribute('aria-label', 'Dismiss');
                closeBtn.innerHTML = '&times;';
                closeBtn.addEventListener('click', function () {
                    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
                    hideToast(toast);
                });
                toast.appendChild(closeBtn);
            }

            chatWin.appendChild(toast);

            // Force a reflow so the fade-in transition actually animates.
            void toast.offsetWidth;
            toast.classList.add('mcp-toast-show');

            toastTimer = setTimeout(function () {
                hideToast(toast);
            }, opts.duration || 3500);
        }

        // ── Voice input (Web Speech API dictation) ────────────────
        // Browser-native speech-to-text. No backend, no cost: the browser
        // captures the mic and streams back text, which we drop into the
        // textarea exactly as if the user had typed it. The user still
        // reviews and presses send — dictation never auto-sends.
        //
        // Only Chromium/Safari expose SpeechRecognition; on browsers that
        // don't (e.g. Firefox) we hide the button entirely rather than show
        // a control that does nothing.
        var SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!micBtn || !SpeechRecognition) {
            if (micBtn) { micBtn.classList.add('d-none'); }
        } else {
            // recognition  : the live SpeechRecognition instance (null when idle)
            // recognizing  : true between onstart and onend
            // micBaseText  : whatever was already in the box when we started,
            //                so dictation appends instead of clobbering it
            // finalText    : accumulated finalised transcript for this session
            var recognition  = null;
            var recognizing  = false;
            var micBaseText  = '';
            var finalText    = '';

            // Reset the button back to its idle look. Called from onend and
            // onerror (both always fire once a session terminates).
            function stopMicUI() {
                recognizing = false;
                micBtn.classList.remove('mcp-mic-recording');
                micBtn.title = 'Voice input';
            }

            function startDictation() {
                recognition = new SpeechRecognition();
                // Match the page language so accents/words resolve correctly;
                // fall back to the browser locale, then English.
                recognition.lang =
                    document.documentElement.lang ||
                    navigator.language ||
                    'en-US';
                recognition.interimResults = true;   // show text live as spoken
                recognition.continuous     = false;  // stop on a natural pause
                recognition.maxAlternatives = 1;

                // Snapshot the current input so we append after it (with a
                // separating space) rather than overwriting a half-typed line.
                micBaseText = input.value
                    ? input.value.replace(/\s*$/, '') + ' '
                    : '';
                finalText = '';

                recognition.onstart = function () {
                    recognizing = true;
                    micBtn.classList.add('mcp-mic-recording');
                    micBtn.title = 'Stop recording';
                };

                // Each event may carry finalised + still-interim chunks. We
                // keep finals permanently and repaint the interim tail every
                // time, so the textarea mirrors what the user is saying.
                recognition.onresult = function (event) {
                    var interim = '';
                    for (var i = event.resultIndex; i < event.results.length; i++) {
                        var transcript = event.results[i][0].transcript;
                        if (event.results[i].isFinal) {
                            finalText += transcript;
                        } else {
                            interim += transcript;
                        }
                    }
                    input.value = micBaseText + finalText + interim;
                    updateSendVisibility();
                    autoResizeInput();
                };

                // Surface the user-actionable failures as a toast; benign ones
                // (e.g. 'no-speech' / 'aborted') just reset the UI silently.
                recognition.onerror = function (e) {
                    console.warn('[mcp_chatbot] Speech recognition error:', e.error);
                    var toastMessages = {
                        'not-allowed':         'Microphone access denied. Check your browser permissions.',
                        'service-not-allowed': 'Microphone access denied. Check your browser permissions.',
                        'audio-capture':       'No microphone found. Plug one in and try again.',
                        'network':             'Voice service unavailable. Check your connection.',
                    };
                    if (toastMessages[e.error]) { showToast(toastMessages[e.error]); }
                    stopMicUI();
                };

                // Always fires when a session ends (stop, pause, or error).
                recognition.onend = function () {
                    stopMicUI();
                    input.focus();
                };

                try {
                    recognition.start();
                } catch (err) {
                    // start() throws if called while already running.
                    console.warn('[mcp_chatbot] Could not start dictation:', err);
                    stopMicUI();
                }
            }

            // Click toggles: a second click (or clicking while live) stops it.
            micBtn.addEventListener('click', function () {
                if (input.disabled) { return; }   // chat offline → ignore
                if (recognizing) {
                    if (recognition) { recognition.stop(); }
                    return;
                }
                startDictation();
            });
        }

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
