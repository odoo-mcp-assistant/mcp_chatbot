/**
 * chatbot_render.js — rendering / DOM helpers
 *
 * Pure display logic: markdown → HTML, chat bubbles, typing indicator,
 * compacting bar, and the hero empty-state greeting.
 * No network calls are made here.
 *
 * Exposes window.McpChatbotRender.
 *
 * Load order: after chatbot_api.js, before chatbot_widget.js.
 */

(function () {
    'use strict';

    // ──────────────────────────────────────────────────────────────
    // Markdown renderer — FAST path for streaming
    // ──────────────────────────────────────────────────────────────

    var _codeStash = [];
    var _codeMap = {};

    function _stashCode(html) {
        var key = '\x00CODE' + _codeStash.length + '\x00';
        _codeStash.push(html);
        _codeMap[key] = html;
        return key;
    }

    function _restoreCodes(text) {
        return text.replace(/\x00CODE\d+\x00/g, function (ph) {
            return _codeMap[ph] || ph;
        });
    }

    function _resetStash() {
        _codeStash = [];
        _codeMap = {};
    }

    function renderMarkdown(text, opts) {
        opts = opts || {};
        var isStreaming = !!opts.streaming;

        var escaped = String(text || '').replace(/\r\n?/g, '\n');

        // 1. Escape raw HTML
        escaped = escaped
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 2. Stash code blocks
        if (!isStreaming) {
            _resetStash();
        }

        escaped = escaped.replace(/```[\w]*\n?([\s\S]*?)```/g, function (_, code) {
            return _stashCode('<pre class="mcp-md-pre"><code>' + code.trim() + '</code></pre>');
        });
        escaped = escaped.replace(/`([^`\n]+)`/g, function (_, code) {
            return _stashCode('<code class="mcp-md-code">' + code + '</code>');
        });

        // 3. Inline formatting
        escaped = escaped.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
        escaped = escaped.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

        // 4. Headings
        escaped = escaped.replace(/^[ \t]{0,3}###### (.+?)\s*$/gm, '<h6 class="mcp-md-h">$1</h6>');
        escaped = escaped.replace(/^[ \t]{0,3}##### (.+?)\s*$/gm,  '<h5 class="mcp-md-h">$1</h5>');
        escaped = escaped.replace(/^[ \t]{0,3}#### (.+?)\s*$/gm,   '<h4 class="mcp-md-h">$1</h4>');
        escaped = escaped.replace(/^[ \t]{0,3}### (.+?)\s*$/gm,    '<h4 class="mcp-md-h">$1</h4>');
        escaped = escaped.replace(/^[ \t]{0,3}## (.+?)\s*$/gm,     '<h3 class="mcp-md-h">$1</h3>');
        escaped = escaped.replace(/^[ \t]{0,3}# (.+?)\s*$/gm,      '<h2 class="mcp-md-h">$1</h2>');

        // 5. Horizontal rule
        escaped = escaped.replace(/^[ \t]*(?:[-*_][ \t]*){3,}[ \t]*$/gm, '<hr class="mcp-md-hr">');

        // 6. Lists
        escaped = escaped.replace(/((?:^[ \t]*[-*+][ \t]+.+\n?)+)/gm, function (block) {
            var items = block.trim().split(/\n/).map(function (line) {
                return '<li>' + line.replace(/^[ \t]*[-*+][ \t]+/, '') + '</li>';
            });
            return '<ul class="mcp-md-ul">' + items.join('') + '</ul>';
        });
        escaped = escaped.replace(/((?:^[ \t]*\d+\.[ \t]+.+\n?)+)/gm, function (block) {
            var items = block.trim().split(/\n/).map(function (line) {
                return '<li>' + line.replace(/^[ \t]*\d+\.[ \t]+/, '') + '</li>';
            });
            return '<ol class="mcp-md-ol">' + items.join('') + '</ol>';
        });

        // 7. Blockquote
        escaped = escaped.replace(/((?:^&gt;[ \t]?.*\n?)+)/gm, function (block) {
            var inner = block.trim().split(/\n/).map(function (line) {
                return line.replace(/^&gt;[ \t]?/, '');
            }).join('<br>');
            return '<blockquote class="mcp-md-blockquote">' + inner + '</blockquote>';
        });

        // 8. GFM tables
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

        // 9. Links
        escaped = escaped.replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
            '<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        );
        escaped = escaped.replace(
            /(^|[^"'>=])\b(https?:\/\/[^\s<)]+)/g,
            '$1<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
        );

        // 10. Paragraphs
        var blocks = escaped.split(/\n{2,}/);
        escaped = blocks.map(function (block) {
            var trimmed = block.trim();
            if (!trimmed) { return ''; }
            if (/^<(h[2-6]|ul|ol|pre|blockquote|hr|table)/.test(trimmed)) { return trimmed; }
            return '<p class="mcp-md-p">' + trimmed.replace(/\n/g, '<br>') + '</p>';
        }).join('');

        // 11. Restore stashed code blocks
        escaped = _restoreCodes(escaped);

        return escaped;
    }

    // ──────────────────────────────────────────────────────────────
    // DOM helpers
    // ──────────────────────────────────────────────────────────────

    function getAvatarSrc() {
        var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
        return headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/ai-logo.jpeg';
    }

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
            avatar.src = getAvatarSrc();
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

    // ── Streaming bubble with LIVE markdown + trailing cursor ─────

    function createStreamingBubble(container) {
        var bubble = document.createElement('div');
        bubble.className = 'mcp-chatbot-msg assistant streaming';

        var inner = document.createElement('div');
        inner.className = 'mcp-assistant-inner';

        var avatarWrap = document.createElement('span');
        avatarWrap.className = 'mcp-assistant-avatar-wrap';
        var avatar = document.createElement('img');
        avatar.className = 'mcp-assistant-avatar';
        avatar.src = getAvatarSrc();
        avatar.alt = '';
        avatarWrap.appendChild(avatar);

        var textSpan = document.createElement('span');
        textSpan.className = 'mcp-assistant-text';
        textSpan.innerHTML = '';

        inner.appendChild(avatarWrap);
        inner.appendChild(textSpan);
        bubble.appendChild(inner);

        container.appendChild(bubble);
        container.scrollTop = container.scrollHeight;

        return { bubble: bubble, textSpan: textSpan };
    }

    // rAF-throttle streaming updates so we re-render at most once per frame.
    // Each token chunk replaces innerHTML, which is expensive — batching keeps
    // the bubble visually stable instead of flickering on every chunk.
    function updateStreamingBubble(textSpan, text) {
        textSpan.__streamPendingText = text;
        if (textSpan.__streamRaf) { return; }
        textSpan.__streamRaf = window.requestAnimationFrame(function () {
            textSpan.__streamRaf = 0;
            var pending = textSpan.__streamPendingText;
            if (pending == null) { return; }
            _renderStreamingFrame(textSpan, pending);
            textSpan.__streamPendingText = null;
        });
    }

    var VOID_TAGS = { BR: 1, HR: 1, IMG: 1, INPUT: 1, WBR: 1 };

    function _renderStreamingFrame(textSpan, text) {
        var html = renderMarkdown(text, { streaming: true });
        if (textSpan.__streamLastHtml === html) { return; }
        textSpan.__streamLastHtml = html;
        textSpan.innerHTML = html;

        var indicator = document.createElement('span');
        indicator.className = 'mcp-stream-indicator';

        // Walk to the deepest last element, but never descend into void
        // elements (br/hr/img) since they can't host children — the bubble
        // would disappear or land on a new line.
        var target = textSpan;
        while (target.lastElementChild && !VOID_TAGS[target.lastElementChild.tagName]) {
            target = target.lastElementChild;
        }
        // If the deepest leaf's last child is a void tag (e.g. trailing <br>),
        // insert the bubble BEFORE it so it stays on the previous line.
        var voidTail = target.lastElementChild;
        if (voidTail && VOID_TAGS[voidTail.tagName]) {
            target.insertBefore(indicator, voidTail);
        } else {
            target.appendChild(indicator);
        }
    }

    function finalizeStreamingBubble(bubble, textSpan, text) {
        if (textSpan.__streamRaf) {
            window.cancelAnimationFrame(textSpan.__streamRaf);
            textSpan.__streamRaf = 0;
        }
        textSpan.__streamPendingText = null;
        textSpan.__streamLastHtml = null;
        _resetStash();
        textSpan.innerHTML = renderMarkdown(text, { streaming: false });
        bubble.classList.remove('streaming');
    }

    // ── Fallback typewriter (non-streaming JSON path) ─────────────

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
        avatar.src = getAvatarSrc();
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

        var renderedHTML = renderMarkdown(text);
        var words = renderedHTML.split(/(<[^>]+>|\s+)/);
        words = words.filter(function (w) { return w.length > 0; });

        var i = 0;
        var accumulated = '';

        function tick() {
            if (i >= words.length) {
                textSpan.innerHTML = renderedHTML;
                if (onDone) { onDone(); }
                return;
            }

            var distanceFromBottom =
                container.scrollHeight - container.scrollTop - container.clientHeight;
            var wasStickyToBottom = distanceFromBottom < STICK_THRESHOLD_PX;

            accumulated += words[i];
            i++;
            textSpan.innerHTML = accumulated;

            if (wasStickyToBottom) {
                container.scrollTop = container.scrollHeight;
            }
            setTimeout(tick, DELAY_MS);
        }
        tick();
    }

    // ── Typing indicator ──────────────────────────────────────────

    function showTyping(container) {
        var indicator = document.createElement('div');
        indicator.className = 'mcp-chatbot-msg assistant typing';

        var inner = document.createElement('div');
        inner.className = 'mcp-assistant-inner';

        var avatarWrap = document.createElement('span');
        avatarWrap.className = 'mcp-assistant-avatar-wrap';
        var avatar = document.createElement('img');
        avatar.className = 'mcp-assistant-avatar';
        avatar.src = getAvatarSrc();
        avatar.alt = '';
        avatarWrap.appendChild(avatar);

        var textSpan = document.createElement('span');
        textSpan.className = 'mcp-assistant-text';
        textSpan.innerHTML = (
            '<span class="mcp-chatbot-dots">' +
                '<span></span><span></span><span></span>' +
            '</span>'
        );

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

        setTimeout(function () {
            if (bar.parentNode) { bar.parentNode.removeChild(bar); }
        }, 5000);
    }

    // ──────────────────────────────────────────────────────────────
    // Hero greeting (empty-state)
    // ──────────────────────────────────────────────────────────────

    var heroIdentity = { isAuthenticated: false, firstName: '' };

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
            morning:   ['Good morning, ' + name,   'Morning, ' + name,            'Rise and shine, ' + name],
            afternoon: ['Good afternoon, ' + name, 'Hey ' + name,                 'Welcome back, ' + name],
            evening:   ['Good evening, ' + name,   'Evening, ' + name,            'Welcome back, ' + name],
            night:     ['Still up, ' + name + '?', 'Working late, ' + name + '?', 'Welcome back, ' + name],
        };

        var anonByTime = {
            morning:   ['Good morning',   'Hi there',        'Hello, ready to start?'],
            afternoon: ['Good afternoon', 'Hey there',       'Hi, how can I help?'],
            evening:   ['Good evening',   'Hi there',        'Hello, how can I help?'],
            night:     ['Hi there',       'Still browsing?', 'Hello, how can I help?'],
        };

        var pool = isAuthenticated ? authedByTime[tod] : anonByTime[tod];
        var primary = pool[Math.floor(Math.random() * pool.length)];

        var subPool = isAuthenticated
            ? ['How can I help you today?', 'What can I do for you?', 'What’s on your mind?']
            : ['How can I help you today?', 'Ask me anything about our products.', 'What are you looking for today?'];
        var sub = subPool[Math.floor(Math.random() * subPool.length)];

        return { primary: primary.replace(/,\s*$/, ''), sub: sub };
    }

    function setEmptyState(on) {
        var win = document.getElementById('mcp_chatbot_window');
        if (!win) { return; }
        win.classList.toggle('mcp-is-empty', !!on);
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

        var badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'mcp-chatbot-suggestion mcp-chatbot-capabilities';
        badge.setAttribute(
            'data-query',
            'Give me a quick tour of what you can do — list your main capabilities with a short example for each.'
        );
        badge.innerHTML = (
            '<i class="fa fa-magic mcp-cap-icon-magic"></i>' +
            '<span>Get to know me</span>' +
            '<i class="fa fa-arrow-right mcp-cap-icon-arrow"></i>'
        );

        wrap.appendChild(primary);
        wrap.appendChild(sub);
        wrap.appendChild(badge);
        container.appendChild(wrap);
    }

    function removeHero(container) {
        var existing = container.querySelector('#mcp_chatbot_hero');
        if (existing) { existing.remove(); }
        setEmptyState(false);
    }

    function setHeroIdentity(identity) {
        heroIdentity.isAuthenticated = !!identity.isAuthenticated;
        heroIdentity.firstName       = identity.firstName || '';
    }

    window.McpChatbotRender = {
        renderMarkdown:          renderMarkdown,
        appendMessage:           appendMessage,
        streamMessageIntoBubble: streamMessageIntoBubble,
        createStreamingBubble:   createStreamingBubble,
        updateStreamingBubble:   updateStreamingBubble,
        finalizeStreamingBubble: finalizeStreamingBubble,
        showTyping:              showTyping,
        showCompactingBar:       showCompactingBar,
        setEmptyState:           setEmptyState,
        renderHero:              renderHero,
        removeHero:              removeHero,
        setHeroIdentity:         setHeroIdentity,
    };

})();