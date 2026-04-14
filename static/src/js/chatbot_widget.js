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
     * 2. For logged-in users, no token is stored. The session is identified
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
            // For logged-in users, no token is used.
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
        // Markdown renderer
        // Converts the LLM's markdown output to safe HTML.
        // No external library — runs fully inline.
        // ──────────────────────────────────────────────────────────────

        function renderMarkdown(text) {
            // Normalise line endings so regexes using \n work regardless of
            // what the LLM emitted on Windows/Mac tools paths.
            var escaped = String(text || '').replace(/\r\n?/g, '\n');

            // 1. Escape raw HTML to prevent XSS
            escaped = escaped
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            // 2. Stash code blocks with placeholders so later rules
            //    (bold, italic, lists…) can't mangle their contents.
            //    Fenced code blocks first, then inline code.
            var codeStash = [];
            function stash(html) {
                var i = codeStash.length;
                codeStash.push(html);
                return '\x00CODE' + i + '\x00';
            }

            escaped = escaped.replace(/```[\w]*\n?([\s\S]*?)```/g, function (_, code) {
                return stash('<pre class="mcp-md-pre"><code>' + code.trim() + '</code></pre>');
            });
            escaped = escaped.replace(/`([^`\n]+)`/g, function (_, code) {
                return stash('<code class="mcp-md-code">' + code + '</code>');
            });

            // 3. Bold+italic (***text***)
            escaped = escaped.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');

            // 4. Bold (**text**) — allow any non-newline content so
            //    nested italics like **foo *bar* baz** don't break bold.
            escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');

            // 5. Italic (*text*) — still non-nested, line-bounded
            escaped = escaped.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

            // 6. Strikethrough (~~text~~)
            escaped = escaped.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

            // 7. Headings (# … ######). Cap visual size via CSS.
            escaped = escaped.replace(/^[ \t]{0,3}###### (.+?)\s*$/gm, '<h6 class="mcp-md-h">$1</h6>');
            escaped = escaped.replace(/^[ \t]{0,3}##### (.+?)\s*$/gm,  '<h5 class="mcp-md-h">$1</h5>');
            escaped = escaped.replace(/^[ \t]{0,3}#### (.+?)\s*$/gm,   '<h4 class="mcp-md-h">$1</h4>');
            escaped = escaped.replace(/^[ \t]{0,3}### (.+?)\s*$/gm,    '<h4 class="mcp-md-h">$1</h4>');
            escaped = escaped.replace(/^[ \t]{0,3}## (.+?)\s*$/gm,     '<h3 class="mcp-md-h">$1</h3>');
            escaped = escaped.replace(/^[ \t]{0,3}# (.+?)\s*$/gm,      '<h2 class="mcp-md-h">$1</h2>');

            // 8. Horizontal rule — tolerate leading/trailing whitespace and
            //    the `___` variant alongside `---` / `***`.
            escaped = escaped.replace(/^[ \t]*(?:[-*_][ \t]*){3,}[ \t]*$/gm, '<hr class="mcp-md-hr">');

            // 9. Unordered lists (- item or * item)
            escaped = escaped.replace(/((?:^[ \t]*[-*+][ \t]+.+\n?)+)/gm, function (block) {
                var items = block.trim().split(/\n/).map(function (line) {
                    return '<li>' + line.replace(/^[ \t]*[-*+][ \t]+/, '') + '</li>';
                });
                return '<ul class="mcp-md-ul">' + items.join('') + '</ul>';
            });

            // 10. Ordered lists (1. item)
            escaped = escaped.replace(/((?:^[ \t]*\d+\.[ \t]+.+\n?)+)/gm, function (block) {
                var items = block.trim().split(/\n/).map(function (line) {
                    return '<li>' + line.replace(/^[ \t]*\d+\.[ \t]+/, '') + '</li>';
                });
                return '<ol class="mcp-md-ol">' + items.join('') + '</ol>';
            });

            // 11. Blockquote — merge consecutive `> …` lines into one block
            escaped = escaped.replace(/((?:^&gt;[ \t]?.*\n?)+)/gm, function (block) {
                var inner = block.trim().split(/\n/).map(function (line) {
                    return line.replace(/^&gt;[ \t]?/, '');
                }).join('<br>');
                return '<blockquote class="mcp-md-blockquote">' + inner + '</blockquote>';
            });

            // 12. GFM tables
            //     | h1 | h2 |
            //     |----|----|
            //     | a  | b  |
            escaped = escaped.replace(
                /^[ \t]*\|(.+)\|[ \t]*\n[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*\n((?:[ \t]*\|.*\|[ \t]*\n?)+)/gm,
                function (_, headerLine, bodyBlock) {
                    function splitRow(row) {
                        return row.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '').split('|').map(function (c) {
                            return c.trim();
                        });
                    }
                    var headers = splitRow(headerLine);
                    var head = '<tr>' + headers.map(function (h) {
                        return '<th>' + h + '</th>';
                    }).join('') + '</tr>';
                    var rows = bodyBlock.trim().split('\n').map(function (line) {
                        var cells = splitRow(line);
                        return '<tr>' + cells.map(function (c) {
                            return '<td>' + c + '</td>';
                        }).join('') + '</tr>';
                    }).join('');
                    return '<table class="mcp-md-table"><thead>' + head +
                           '</thead><tbody>' + rows + '</tbody></table>';
                }
            );

            // 13. Links [text](url) — http(s)/mailto only, blocks javascript: injection
            escaped = escaped.replace(
                /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
                '<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
            );

            // 14. Autolinks — bare URLs that aren't already inside an <a>
            escaped = escaped.replace(
                /(^|[^"'>=])\b(https?:\/\/[^\s<)]+)/g,
                '$1<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
            );

            // 15. Paragraphs — wrap double-newline-separated blocks that are
            //     not already block-level HTML elements
            var blocks = escaped.split(/\n{2,}/);
            escaped = blocks.map(function (block) {
                var trimmed = block.trim();
                if (!trimmed) { return ''; }
                // Already a block element — leave untouched
                if (/^<(h[2-6]|ul|ol|pre|blockquote|hr|table)/.test(trimmed)) { return trimmed; }
                // Single newlines inside a paragraph become <br>
                return '<p class="mcp-md-p">' + trimmed.replace(/\n/g, '<br>') + '</p>';
            }).join('');

            // 16. Restore stashed code blocks/inline code
            escaped = escaped.replace(/\x00CODE(\d+)\x00/g, function (_, i) {
                return codeStash[parseInt(i, 10)];
            });

            return escaped;
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

                var avatarWrap = document.createElement('span');
                avatarWrap.className = 'mcp-assistant-avatar-wrap';
                var avatar = document.createElement('img');
                avatar.className = 'mcp-assistant-avatar';
                var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
                avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/ai-logo.jpeg';
                avatar.alt = '';
                avatarWrap.appendChild(avatar);

                var textSpan = document.createElement('span');
                textSpan.className = 'mcp-assistant-text';
                textSpan.innerHTML = renderMarkdown(text);

                inner.appendChild(avatarWrap);
                inner.appendChild(textSpan);
                bubble.appendChild(inner);
            } else {
                bubble.textContent = text;
            }

            container.appendChild(bubble);
            container.scrollTop = container.scrollHeight;
        }

        // Typewriter-style rendering for assistant replies.
        //
        // Strategy: render the full markdown → HTML once upfront, then
        // stream the *rendered HTML* word-by-word using a hidden clone so
        // we never paint a half-open HTML tag into the visible DOM.
        //
        // Auto-scroll uses the standard "sticky bottom" pattern: we only
        // re-scroll while the user is already within STICK_THRESHOLD_PX of
        // the bottom.
        function streamMessageIntoBubble(container, text, onDone) {
            var DELAY_MS = 18;
            var STICK_THRESHOLD_PX = 50;

            var bubble = document.createElement('div');
            bubble.className = 'mcp-chatbot-msg assistant';

            var inner = document.createElement('div');
            inner.className = 'mcp-assistant-inner';

            var textSpan = document.createElement('span');
            textSpan.className = 'mcp-assistant-text';

            var avatarWrap = document.createElement('span');
            avatarWrap.className = 'mcp-assistant-avatar-wrap';
            var avatar = document.createElement('img');
            avatar.className = 'mcp-assistant-avatar';
            var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
            avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/ai-logo.jpeg';
            avatar.alt = '';
            avatarWrap.appendChild(avatar);

            inner.appendChild(avatarWrap);
            inner.appendChild(textSpan);
            bubble.appendChild(inner);

            var initialDistance =
                container.scrollHeight - container.scrollTop - container.clientHeight;
            var wasStickyOnEntry = initialDistance < STICK_THRESHOLD_PX;

            container.appendChild(bubble);
            if (wasStickyOnEntry) {
                container.scrollTop = container.scrollHeight;
            }

            // Render markdown → HTML once, then split into words so we
            // stream whole words (safe for HTML tags) rather than raw chars.
            var renderedHTML = renderMarkdown(text);
            var words = renderedHTML.split(/(<[^>]+>|\s+)/);
            // Filter to tokens that carry visible content or tags
            words = words.filter(function (w) { return w.length > 0; });

            var i = 0;
            var accumulated = '';

            function tick() {
                if (i >= words.length) {
                    // Final render — make sure the full HTML is in place
                    textSpan.innerHTML = renderedHTML;
                    if (onDone) { onDone(); }
                    return;
                }

                var distanceFromBottom =
                    container.scrollHeight - container.scrollTop - container.clientHeight;
                var wasStickyToBottom = distanceFromBottom < STICK_THRESHOLD_PX;

                accumulated += words[i];
                i++;

                // Paint accumulated tokens — browser parses HTML safely
                textSpan.innerHTML = accumulated;

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

            var avatarWrap = document.createElement('span');
            avatarWrap.className = 'mcp-assistant-avatar-wrap';
            var avatar = document.createElement('img');
            avatar.className = 'mcp-assistant-avatar';
            var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
            avatar.src = headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/ai-logo.jpeg';
            avatar.alt = '';
            avatarWrap.appendChild(avatar);

            var textSpan = document.createElement('span');
            textSpan.className = 'mcp-assistant-text';
            textSpan.textContent = 'Thinking...';

            inner.appendChild(avatarWrap);
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
                        clearSessionToken();
                        sessionToken = getSessionToken();
                        container.innerHTML = '';
                        renderHero(container);
                        if (callback) { callback(false); }
                        return;
                    }

                    var messages = result.messages || [];
                    container.innerHTML = '';

                    if (messages.length === 0) {
                        renderHero(container);
                        if (callback) { callback(false); }
                    } else {
                        messages.forEach(function (msg) {
                            appendMessage(container, msg.role, msg.content);
                        });
                        if (callback) { callback(true); }
                    }
                })
                .catch(function () {
                    renderHero(container);
                    if (callback) { callback(false); }
                });
        }

        // ──────────────────────────────────────────────────────────────
        // Hero greeting (empty-state)
        // ──────────────────────────────────────────────────────────────

        function timeOfDay() {
            var h = new Date().getHours();
            if (h < 5)  { return 'night'; }
            if (h < 12) { return 'morning'; }
            if (h < 18) { return 'afternoon'; }
            return 'evening';
        }

        function pickGreeting(isAuthenticated, firstName) {
            var tod  = timeOfDay();
            var name = firstName || '';

            var authedByTime = {
                morning:   ['Good morning, ' + name,   'Morning, ' + name,          'Rise and shine, ' + name],
                afternoon: ['Good afternoon, ' + name, 'Hey ' + name,               'Welcome back, ' + name],
                evening:   ['Good evening, ' + name,   'Evening, ' + name,          'Welcome back, ' + name],
                night:     ['Still up, ' + name + '?', 'Working late, ' + name + '?', 'Welcome back, ' + name],
            };

            var anonByTime = {
                morning:   ['Good morning',   'Hi there',      'Hello, ready to start?'],
                afternoon: ['Good afternoon', 'Hey there',     'Hi, how can I help?'],
                evening:   ['Good evening',   'Hi there',      'Hello, how can I help?'],
                night:     ['Hi there',       'Still browsing?', 'Hello, how can I help?'],
            };

            var pool = isAuthenticated ? authedByTime[tod] : anonByTime[tod];
            var primary = pool[Math.floor(Math.random() * pool.length)];

            var subPool = isAuthenticated
                ? ['How can I help you today?', 'What can I do for you?', 'What\u2019s on your mind?']
                : ['How can I help you today?', 'Ask me anything about our products.', 'What are you looking for today?'];
            var sub = subPool[Math.floor(Math.random() * subPool.length)];

            return { primary: primary.replace(/,\s*$/, ''), sub: sub };
        }

        function setEmptyState(on) {
            var win = document.getElementById('mcp_chatbot_window');
            if (!win) { return; }
            win.classList.toggle('mcp-is-empty', !!on);
            // Pick the suggestion set that matches the auth state. Only
            // applies when we're actually in the empty state.
            win.classList.toggle('mcp-auth-user', !!on && !!heroIdentity.isAuthenticated);
            win.classList.toggle('mcp-auth-anon', !!on && !heroIdentity.isAuthenticated);
        }

        function renderHero(container) {
            removeHero(container);
            setEmptyState(true);
            var g = pickGreeting(heroIdentity.isAuthenticated, heroIdentity.firstName);

            var wrap = document.createElement('div');
            wrap.className = 'mcp-chatbot-hero';
            wrap.id = 'mcp_chatbot_hero';

            var primary = document.createElement('div');
            primary.className = 'mcp-chatbot-hero-primary';
            primary.textContent = g.primary;

            var sub = document.createElement('div');
            sub.className = 'mcp-chatbot-hero-sub';
            sub.textContent = g.sub;

            wrap.appendChild(primary);
            wrap.appendChild(sub);
            container.appendChild(wrap);
        }

        function removeHero(container) {
            var existing = container.querySelector('#mcp_chatbot_hero');
            if (existing) { existing.remove(); }
            setEmptyState(false);
        }

        // ──────────────────────────────────────────────────────────────
        // Header + tooltip helpers
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

        // Identity used by the hero greeting. Populated by /mcp_chatbot/info.
        var heroIdentity = { isAuthenticated: false, firstName: '' };

        // Fetch bot metadata once on page load — populates header title, tooltip, status badge,
        // and the hero greeting identity.
        jsonRpc('/mcp_chatbot/info', {})
            .then(function (result) {
                if (!result) { return; }
                if (result.bot_name) { updateHeaderName(result.bot_name); }
                if (result.status)   { updateStatus(result.status); }
                heroIdentity.isAuthenticated = !!result.is_authenticated;
                heroIdentity.firstName       = result.first_name || '';
                // Re-render the hero if it's already on screen with placeholder identity.
                var msgArea = document.getElementById('mcp_chatbot_messages');
                if (msgArea && msgArea.querySelector('#mcp_chatbot_hero')) {
                    renderHero(msgArea);
                }
            })
            .catch(function () {});  // silent — fallbacks stay as "AI Assistant" / "Online"

        // ──────────────────────────────────────────────────────────────
        // Widget initialisation
        // ──────────────────────────────────────────────────────────────

        // These are declared here so sendMessage can access them
        var sessionToken = null;

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
                // minimised — keep it as-is.
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
                // sees the full conversation when they reopen.
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
                // input itself stays editable so the user can type ahead.
                //
                // This also covers the offline case: updateStatus('offline')
                // disables the send button, so sendMessage() short-circuits
                // here without us having to special-case it.
                if (sendBtn.disabled) { return; }

                var text = input.value.trim();
                if (!text) { return; }

                // First message kicks the hero off the stage.
                removeHero(msgArea);

                appendMessage(msgArea, 'user', text);
                input.value = '';
                sendBtn.disabled = true;
                updateSendVisibility();

                var typingEl = showTyping(msgArea);

                var payload = { message: text };
                // Include session_token only for anonymous users
                if (sessionToken) {
                    payload.session_token = sessionToken;
                }
                function unlockSend() {
                    sendBtn.disabled = false;
                    updateSendVisibility();
                    input.focus();
                }

                jsonRpc('/mcp_chatbot/message', payload)
                    .then(function (result) {
                        if (typingEl) { typingEl.remove(); typingEl = null; }

                        var replyText = result && result.reply
                            ? result.reply
                            : 'Sorry, I could not get a reply.';

                        // Show compacting bar when backend actually summarized
                        if (result && result.summarized) {
                            showCompactingBar(msgArea);
                            setTimeout(function () {
                                streamMessageIntoBubble(msgArea, replyText, unlockSend);
                                setEndSessionVisible(true);
                            }, 5000);
                        } else {
                            streamMessageIntoBubble(msgArea, replyText, unlockSend);
                            setEndSessionVisible(true);
                        }
                    })
                    .catch(function (err) {
                        console.error('[mcp_chatbot] RPC error:', err);
                        if (typingEl) { typingEl.remove(); }
                        appendMessage(msgArea, 'assistant', 'An error occurred. Please try again.');
                        unlockSend();
                    });
            }

            sendBtn.addEventListener('click', sendMessage);

            // ── Suggestion chips (auth + anon) ────────────────────────
            document.querySelectorAll('.mcp-chatbot-suggestion').forEach(function (chip) {
                chip.addEventListener('click', function () {
                    if (sendBtn.disabled) { return; }
                    var query = chip.getAttribute('data-query') || chip.textContent.trim();
                    input.value = query;
                    updateSendVisibility();
                    sendMessage();
                });
            });

            // ── Send button visibility (hide when input is empty) ─────
            function updateSendVisibility() {
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
                    // "still in flight" case.
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
