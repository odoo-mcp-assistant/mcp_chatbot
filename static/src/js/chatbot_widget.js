/**
 * mcp_chatbot/static/src/js/chatbot_widget.js
 *
 * Key design decisions:
 *
 * 1. Session token and history are stored in localStorage keyed by
 *    partner ID (or 'guest' for anonymous). This means switching users
 *    in the same browser starts a clean conversation for each user.
 *
 * 2. On every page load, the widget polls /mcp_chatbot/session_status
 *    with the current token. If the backend says the session is closed
 *    (idle timeout reached), localStorage is cleared and the widget
 *    resets to a fresh state.
 *
 * 3. Sessions are NEVER closed from the frontend explicitly. The backend
 *    cron closes them after 30 min of inactivity.
 */

(function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    // Resolve current user identity from Odoo's session
    // window.odoo.session_info is available on every website page
    // ──────────────────────────────────────────────────────────────

    var partnerId = (
        window.__odoo &&
        window.__odoo.session_info &&
        window.__odoo.session_info.partner_id
    ) || 'guest';

    // ──────────────────────────────────────────────────────────────
    // localStorage keys — scoped per user so switching users gives
    // a clean slate without touching the other user's history
    // ──────────────────────────────────────────────────────────────

    var STORAGE_TOKEN_KEY   = 'mcp_chatbot_token_'   + partnerId;
    var STORAGE_HISTORY_KEY = 'mcp_chatbot_history_' + partnerId;
    var STORAGE_OPEN_KEY    = 'mcp_chatbot_open_'    + partnerId;

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
        var token = localStorage.getItem(STORAGE_TOKEN_KEY);
        if (!token) {
            token = uuidv4();
            localStorage.setItem(STORAGE_TOKEN_KEY, token);
        }
        return token;
    }

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
     * Wipe all localStorage keys for the current user and generate a
     * fresh session token. Called when the backend reports the session
     * has been closed by the idle-timeout cron.
     */
    function resetSession() {
        localStorage.removeItem(STORAGE_TOKEN_KEY);
        localStorage.removeItem(STORAGE_HISTORY_KEY);
        localStorage.removeItem(STORAGE_OPEN_KEY);
        // Re-generate a fresh token immediately so the next message
        // creates a new backend session automatically
        localStorage.setItem(STORAGE_TOKEN_KEY, uuidv4());
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

    function appendMessage(container, role, text, history) {
        var bubble = document.createElement('div');
        bubble.className = 'mcp-chatbot-msg ' + role;
        bubble.textContent = text;
        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;

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
    // Session status check
    // Asks the backend if the current token's session is still open.
    // If closed (idle timeout), wipes localStorage and resets the UI.
    // ──────────────────────────────────────────────────────────────

    function checkSessionStatus(token, onExpired) {
        jsonRpc('/mcp_chatbot/session_status', { session_token: token })
            .then(function (result) {
                if (result && result.status === 'closed') {
                    resetSession();
                    if (onExpired) { onExpired(); }
                }
            })
            .catch(function () { /* network error — keep existing state */ });
    }

    // ──────────────────────────────────────────────────────────────
    // Widget initialisation
    // ──────────────────────────────────────────────────────────────

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

        var sessionToken = getSessionToken();
        var chatHistory  = loadHistory();
        var isOpen = localStorage.getItem(STORAGE_OPEN_KEY) === '1';

        // ── Check if backend session expired on page load ─────────
        checkSessionStatus(sessionToken, function () {
            // Session was closed by cron — reset everything
            sessionToken = getSessionToken();   // fresh token
            chatHistory  = [];
            isOpen       = false;
            chatWin.classList.add('d-none');
        });

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

            if (chatHistory.length === 0) {
                appendMessage(msgArea, 'assistant', 'Hello! How can I help you today?', chatHistory);
            }
        }

        // ── Open / close ──────────────────────────────────────────
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
    // Bootstrap
    // ──────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatbot);
    } else {
        initChatbot();
    }

})();