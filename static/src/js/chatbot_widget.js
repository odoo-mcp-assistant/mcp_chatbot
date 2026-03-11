/**
 * mcp_chatbot/static/src/js/chatbot_widget.js
 *
 * Key design decisions:
 *
 * 1. Session token is stored in localStorage (not sessionStorage).
 *    This means the token — and therefore the open session — survives
 *    page navigation and browser-tab restores. The user's conversation
 *    history is preserved when they move between pages.
 *
 * 2. Sessions are NEVER closed from the frontend. Closing the widget
 *    only hides it visually. The backend cron job (runs every 10 min)
 *    closes sessions that have been idle for 30+ minutes.
 *
 * 3. Chat history (the rendered bubbles) is stored in localStorage so
 *    the widget re-renders the conversation when the user navigates to
 *    a new page and re-opens the widget.
 */

(function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    var STORAGE_TOKEN_KEY   = 'mcp_chatbot_session_token';
    var STORAGE_HISTORY_KEY = 'mcp_chatbot_history';       // rendered message history
    var STORAGE_OPEN_KEY    = 'mcp_chatbot_open';          // whether window was open

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

    /**
     * Get-or-create the session token from localStorage.
     * localStorage persists across page navigations and tab restores,
     * keeping the same backend session alive while the user browses.
     */
    function getSessionToken() {
        var token = localStorage.getItem(STORAGE_TOKEN_KEY);
        if (!token) {
            token = uuidv4();
            localStorage.setItem(STORAGE_TOKEN_KEY, token);
        }
        return token;
    }

    /**
     * Persist the rendered chat history so it can be restored after
     * the user navigates to another page.
     * history: array of { role: 'user'|'assistant', text: string }
     */
    function saveHistory(history) {
        try {
            localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(history));
        } catch (e) { /* storage full — silently ignore */ }
    }

    function loadHistory() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_HISTORY_KEY) || '[]');
        } catch (e) { return []; }
    }

    /**
     * JSON-RPC 2.0 call to an Odoo JSON controller endpoint.
     */
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

    function appendMessage(container, role, text, history) {
        var bubble = document.createElement('div');
        bubble.className = 'mcp-chatbot-msg ' + role;
        bubble.textContent = text;
        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;

        // Persist to localStorage history array
        if (history) {
            history.push({ role: role, text: text });
            saveHistory(history);
        }
    }

    function showTyping(container) {
        var indicator = document.createElement('div');
        indicator.className = 'mcp-chatbot-msg typing';
        indicator.textContent = 'Thinking...';
        container.appendChild(indicator);
        container.scrollTop = container.scrollHeight;
        return indicator;
    }

    // ──────────────────────────────────────────────────────────────
    // Widget initialisation
    // ──────────────────────────────────────────────────────────────

    function initChatbot() {
        // Guard — only initialise once even if snippet appears multiple times
        if (window.__mcpChatbotInit) { return; }
        window.__mcpChatbotInit = true;

        var bubble   = document.getElementById('mcp_chatbot_bubble');
        var chatWin  = document.getElementById('mcp_chatbot_window');
        var closeBtn = chatWin && chatWin.querySelector('.mcp-chatbot-close');
        var msgArea  = document.getElementById('mcp_chatbot_messages');
        var input    = document.getElementById('mcp_chatbot_input');
        var sendBtn  = document.getElementById('mcp_chatbot_send');

        // Bail out if the snippet is not on this page
        if (!bubble || !chatWin || !msgArea || !input || !sendBtn) { return; }

        var sessionToken = getSessionToken();
        var chatHistory  = loadHistory();   // in-memory copy, kept in sync with localStorage
        var isOpen = localStorage.getItem(STORAGE_OPEN_KEY) === '1';

        // ── Restore previous conversation ─────────────────────────
        function restoreHistory() {
            msgArea.innerHTML = '';
            chatHistory.forEach(function (entry) {
                var b = document.createElement('div');
                b.className = 'mcp-chatbot-msg ' + entry.role;
                b.textContent = entry.text;
                msgArea.appendChild(b);
            });
            msgArea.scrollTop = msgArea.scrollHeight;

            // Show welcome only if this is a brand new conversation
            if (chatHistory.length === 0) {
                appendMessage(msgArea, 'assistant', 'Hello! How can I help you today?', chatHistory);
            }
        }

        // ── Open / close (visual only — does NOT end the session) ─
        // Sessions are closed exclusively by the backend cron after
        // 30 minutes of inactivity (last_activity field).
        function openWindow() {
            chatWin.classList.remove('d-none');
            isOpen = true;
            localStorage.setItem(STORAGE_OPEN_KEY, '1');
            restoreHistory();
            input.focus();
        }

        function closeWindow() {
            chatWin.classList.add('d-none');
            isOpen = false;
            localStorage.setItem(STORAGE_OPEN_KEY, '0');
            // NOTE: intentionally NOT calling any end_session endpoint.
            // The backend cron closes sessions after 30 min of inactivity.
        }

        bubble.addEventListener('click', function () {
            isOpen ? closeWindow() : openWindow();
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', closeWindow);
        }

        // Restore open state after page navigation
        if (isOpen) {
            openWindow();
        }

        // ── Send message ──────────────────────────────────────────
        function sendMessage() {
            var text = input.value.trim();
            if (!text) { return; }

            appendMessage(msgArea, 'user', text, chatHistory);
            input.value = '';
            sendBtn.disabled = true;

            var typingEl = showTyping(msgArea);

            jsonRpc('/mcp_chatbot/message', {
                session_token: sessionToken,
                message: text,
            })
                .then(function (result) {
                    typingEl.remove();
                    var reply = (result && result.reply) ? result.reply : 'Sorry, I could not get a reply.';
                    appendMessage(msgArea, 'assistant', reply, chatHistory);
                })
                .catch(function (err) {
                    typingEl.remove();
                    appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.', chatHistory);
                    console.error('[mcp_chatbot] RPC error:', err);
                })
                .finally(function () {
                    sendBtn.disabled = false;
                    input.focus();
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
    // Bootstrap — wait for DOM ready
    // ──────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatbot);
    } else {
        initChatbot();
    }

})();
