/**
 * chatbot_widget.js — UI state and event wiring
 *
 * Depends on:
 *   window.McpChatbotAPI   (chatbot_api.js)
 *   window.McpChatbotRender (chatbot_render.js)
 *
 * Load order in web.assets_frontend:
 *   1. chatbot_api.js
 *   2. chatbot_render.js
 *   3. chatbot_widget.js  ← this file
 */

(function () {
    'use strict';

    var API    = window.McpChatbotAPI;
    var Render = window.McpChatbotRender;

    // ──────────────────────────────────────────────────────────────
    // Load history from backend
    // ──────────────────────────────────────────────────────────────

    function loadHistoryFromBackend(container, callback) {
        API.apiRequest('/mcp_chatbot/history', {})
            .then(function (result) {
                if (!result || result.status === 'closed' || result.status === 'not_found') {
                    API.handleSessionGone();
                    container.innerHTML = '';
                    Render.renderHero(container);
                    if (callback) { callback(false); }
                    return;
                }

                var messages = result.messages || [];
                container.innerHTML = '';

                if (messages.length === 0) {
                    Render.renderHero(container);
                    if (callback) { callback(false); }
                } else {
                    messages.forEach(function (msg) {
                        Render.appendMessage(container, msg.role, msg.content);
                    });
                    if (callback) { callback(true); }
                }
            })
            .catch(function () {
                Render.renderHero(container);
                if (callback) { callback(false); }
            });
    }

    // ──────────────────────────────────────────────────────────────
    // Header + status helpers
    // ──────────────────────────────────────────────────────────────

    function updateHeaderName(name) {
        var titleEl = document.getElementById('mcp_chatbot_title');
        if (titleEl && name) { titleEl.textContent = name; }
        var tooltipNameEl = document.getElementById('mcp_chatbot_tooltip_name');
        if (tooltipNameEl && name) { tooltipNameEl.textContent = name; }
        var disclaimerNameEl = document.getElementById('mcp_chatbot_disclaimer_name');
        if (disclaimerNameEl && name) { disclaimerNameEl.textContent = name; }
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

    // Fetch bot metadata once on page load
    API.apiRequest('/mcp_chatbot/info', {})
        .then(function (result) {
            if (!result) { return; }
            if (result.bot_name) { updateHeaderName(result.bot_name); }
            if (result.status)   { updateStatus(result.status); }
            Render.setHeroIdentity({
                isAuthenticated: !!result.is_authenticated,
                firstName:       result.first_name || '',
            });
            var msgArea = document.getElementById('mcp_chatbot_messages');
            if (msgArea && msgArea.querySelector('#mcp_chatbot_hero')) {
                Render.renderHero(msgArea);
            }
        })
        .catch(function () {});

    // ──────────────────────────────────────────────────────────────
    // Widget initialisation
    // ──────────────────────────────────────────────────────────────

    function initChatbot() {
        if (window.__mcpChatbotInit) { return; }
        window.__mcpChatbotInit = true;

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

        if (!bubble || !chatWin || !msgArea || !input || !sendBtn) { return; }

        // Portal the chatbot's fixed UI out of #wrapwrap
        [bubble, bubbleTooltip, chatWin].forEach(function (el) {
            if (el && el.parentNode !== document.body) {
                document.body.appendChild(el);
            }
        });

        var isOpen = sessionStorage.getItem(API.OPEN_KEY) === '1';
        var sessionGen = 0;

        // ── Scroll-to-bottom button ───────────────────────────────
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
        setEndSessionVisible(false);

        // ── Open / close ──────────────────────────────────────────
        function openWindow() {
            chatWin.classList.remove('d-none');
            bubble.classList.add('d-none');
            document.body.classList.add('mcp-chatbot-open');
            isOpen = true;
            sessionStorage.setItem(API.OPEN_KEY, '1');
            if (bubble) { bubble.classList.remove('mcp-bubble-hovered'); }
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
        }

        bubble.addEventListener('click', function () {
            isOpen ? closeWindow() : openWindow();
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', closeWindow);
        }

        // ── Expand / collapse to 50% width ───────────────────────
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
                sessionGen++;
                sendBtn.disabled = false;
                updateSendVisibility();
                var payload = {};
                if (selectedRating !== null) {
                    payload.rating = selectedRating;
                }
                if (feedbackArea && feedbackArea.value.trim()) {
                    payload.feedback = feedbackArea.value.trim();
                }
                API.apiRequest('/mcp_chatbot/close', payload)
                    .then(function () {
                        setEndSessionVisible(false);
                        API.handleSessionGone();
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

        if (isOpen) {
            openWindow();
        }

        // ── Send message (streaming) ──────────────────────────────
                // ── Send message (streaming) ──────────────────────────────
                // ── Send message (true streaming) ─────────────────────────
        function sendMessage() {
            if (sendBtn.disabled) { return; }

            var text = input.value.trim();
            if (!text) { return; }

            Render.removeHero(msgArea);
            Render.appendMessage(msgArea, 'user', text);
            input.value = '';
            autoResizeInput();
            sendBtn.disabled = true;
            updateSendVisibility();

            var typingEl = Render.showTyping(msgArea);
            var myGen = sessionGen;

            var streamBubble = null;
            var streamTextSpan = null;
            var accumulatedText = '';
            var didSummarize = false;

            function unlockSend() {
                sendBtn.disabled = false;
                updateSendVisibility();
                input.focus();
            }

            function onMeta(data) {
                if (sessionGen !== myGen) { return; }
                if (data && data.summarized) {
                    didSummarize = true;
                    Render.showCompactingBar(msgArea);
                }
            }

                function onChunk(chunkText) {
                if (sessionGen !== myGen) { return; }
                if (typingEl) { typingEl.remove(); typingEl = null; }

                if (!streamBubble) {
                    var created = Render.createStreamingBubble(msgArea);
                    streamBubble = created.bubble;
                    streamTextSpan = created.textSpan;
                }

                accumulatedText += chunkText;
                Render.updateStreamingBubble(streamTextSpan, accumulatedText);

                var distanceFromBottom =
                    msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight;
                if (distanceFromBottom < 50) {
                    msgArea.scrollTop = msgArea.scrollHeight;
                }
            }

            function onDone(data) {
                if (sessionGen !== myGen) { return; }
                if (typingEl) { typingEl.remove(); typingEl = null; }

                if (streamBubble) {
                    Render.finalizeStreamingBubble(streamBubble, streamTextSpan, accumulatedText);
                } else {
                    // No chunks arrived — show fallback
                    var fallback = (data && data.reply)
                        ? data.reply
                        : 'Sorry, I could not get a reply.';
                    Render.appendMessage(msgArea, 'assistant', fallback);
                }

                setEndSessionVisible(true);
                unlockSend();
            }

            function onError(err) {
                if (sessionGen !== myGen) { return; }
                console.error('[mcp_chatbot] Stream error:', err);
                if (typingEl) { typingEl.remove(); }
                if (streamBubble) { streamBubble.remove(); streamBubble = null; }

                // Fallback to non-streaming JSON endpoint
                API.apiRequest('/mcp_chatbot/message', { message: text })
                    .then(function (result) {
                        if (sessionGen !== myGen) { return; }
                        var replyText = result && result.reply
                            ? result.reply
                            : 'Sorry, I could not get a reply.';
                        if (result && result.summarized) {
                            Render.showCompactingBar(msgArea);
                        }
                        Render.streamMessageIntoBubble(msgArea, replyText, function () {
                            setEndSessionVisible(true);
                            unlockSend();
                        });
                    })
                    .catch(function (err2) {
                        if (sessionGen !== myGen) { return; }
                        console.error('[mcp_chatbot] Fallback error:', err2);
                        Render.appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.');
                        unlockSend();
                    });
            }

            API.apiRequestStream('/mcp_chatbot/message/stream', { message: text }, {
                onMeta: onMeta,
                onChunk: onChunk,
                onDone: onDone,
                onError: onError,
            });
        }
        sendBtn.addEventListener('click', sendMessage);

        // ── Suggestion chips ──────────────────────────────────────
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
        // so we delegate the click from the message container.
        msgArea.addEventListener('click', function (e) {
            var badge = e.target.closest && e.target.closest('.mcp-chatbot-capabilities');
            if (!badge || sendBtn.disabled) { return; }
            var query = badge.getAttribute('data-query') || badge.textContent.trim();
            input.value = query;
            updateSendVisibility();
            sendMessage();
        });

        // ── Send button visibility (hidden when input is empty) ───
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
        function autoResizeInput() {
            input.style.height = 'auto';
            var sh = input.scrollHeight;
            if (!sh) { return; }
            var max = 88;
            input.style.height = Math.min(sh, max) + 'px';
        }
        autoResizeInput();
        input.addEventListener('input', autoResizeInput);

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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatbot);
    } else {
        initChatbot();
    }

})();