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
    // Markdown renderer
    // Converts the LLM's markdown output to safe HTML.
    // ──────────────────────────────────────────────────────────────

    function renderMarkdown(text) {
        var escaped = String(text || '').replace(/\r\n?/g, '\n');

        // 1. Escape raw HTML to prevent XSS
        escaped = escaped
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 2. Stash code blocks so later rules can't mangle their contents.
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

        // 4. Bold (**text**)
        escaped = escaped.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');

        // 5. Italic (*text*)
        escaped = escaped.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

        // 6. Strikethrough (~~text~~)
        escaped = escaped.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

        // 7. Headings (# … ######)
        escaped = escaped.replace(/^[ \t]{0,3}###### (.+?)\s*$/gm, '<h6 class="mcp-md-h">$1</h6>');
        escaped = escaped.replace(/^[ \t]{0,3}##### (.+?)\s*$/gm,  '<h5 class="mcp-md-h">$1</h5>');
        escaped = escaped.replace(/^[ \t]{0,3}#### (.+?)\s*$/gm,   '<h4 class="mcp-md-h">$1</h4>');
        escaped = escaped.replace(/^[ \t]{0,3}### (.+?)\s*$/gm,    '<h4 class="mcp-md-h">$1</h4>');
        escaped = escaped.replace(/^[ \t]{0,3}## (.+?)\s*$/gm,     '<h3 class="mcp-md-h">$1</h3>');
        escaped = escaped.replace(/^[ \t]{0,3}# (.+?)\s*$/gm,      '<h2 class="mcp-md-h">$1</h2>');

        // 8. Horizontal rule
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

        // 11. Blockquote
        escaped = escaped.replace(/((?:^&gt;[ \t]?.*\n?)+)/gm, function (block) {
            var inner = block.trim().split(/\n/).map(function (line) {
                return line.replace(/^&gt;[ \t]?/, '');
            }).join('<br>');
            return '<blockquote class="mcp-md-blockquote">' + inner + '</blockquote>';
        });

        // 12. GFM tables
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

        // 13. Links [text](url)
        escaped = escaped.replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
            '<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        );

        // 14. Autolinks — bare URLs not already inside an <a>
        escaped = escaped.replace(
            /(^|[^"'>=])\b(https?:\/\/[^\s<)]+)/g,
            '$1<a class="mcp-md-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
        );

        // 15. Paragraphs
        var blocks = escaped.split(/\n{2,}/);
        escaped = blocks.map(function (block) {
            var trimmed = block.trim();
            if (!trimmed) { return ''; }
            if (/^<(h[2-6]|ul|ol|pre|blockquote|hr|table)/.test(trimmed)) { return trimmed; }
            return '<p class="mcp-md-p">' + trimmed.replace(/\n/g, '<br>') + '</p>';
        }).join('');

        // 16. Restore stashed code blocks
        escaped = escaped.replace(/\x00CODE(\d+)\x00/g, function (_, i) {
            return codeStash[parseInt(i, 10)];
        });

        return escaped;
    }

    // ──────────────────────────────────────────────────────────────
    // DOM helpers
    // ──────────────────────────────────────────────────────────────

    function getAvatarSrc() {
        var headerLogo = document.querySelector('.mcp-chatbot-header-logo');
        return headerLogo ? headerLogo.src : '/mcp_chatbot/static/src/img/ai-logo.jpeg';
    }

    // Append a message bubble. For assistant messages, passing `existingBubble`
    // appends this text as a new block INSIDE that bubble (used to keep a turn
    // one continuous message, e.g. an error line after streamed text) instead
    // of creating a separate bubble. Returns the bubble so callers can reuse it.
    function appendMessage(container, role, text, existingBubble) {
        // Continue an existing assistant message rather than starting a new one.
        if (role === 'assistant' && existingBubble) {
            var span = existingBubble.querySelector('.mcp-assistant-text');
            if (span) {
                span.innerHTML = (span.innerHTML || '') + renderMarkdown(text);
            }
            container.scrollTop = container.scrollHeight;
            return existingBubble;
        }

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
        return bubble;
    }

    // ── Live token streaming ──────────────────────────────────────
    // The backend streams the assistant's text token-by-token (SSE deltas);
    // there is no client-side typewriter — what you see paint IS the model
    // generating.
    //
    // appendDelta() accumulates the RAW markdown of the whole turn on the
    // bubble node itself (bubble._mcpRaw) and re-renders it on every chunk,
    // so partially-streamed markdown (an unclosed **bold**, half a table) is
    // re-evaluated as more text arrives instead of freezing as broken HTML.
    // Creates the bubble on the first chunk. Sticky-scroll: only follows the
    // stream while the user is already near the bottom. Returns the bubble.
    //
    // Works against the detached history fragment too: a DocumentFragment has
    // no scroll metrics, so the sticky check is simply never true there.
    function appendDelta(container, bubble, text) {
        var STICK_THRESHOLD_PX = 50;
        if (!bubble) {
            bubble = appendMessage(container, 'assistant', '');
            bubble._mcpRaw = '';
        }
        bubble._mcpRaw = (bubble._mcpRaw || '') + text;

        var distance =
            container.scrollHeight - container.scrollTop - container.clientHeight;
        var wasSticky = distance < STICK_THRESHOLD_PX;

        var span = bubble.querySelector('.mcp-assistant-text');
        if (span) { span.innerHTML = renderMarkdown(bubble._mcpRaw); }

        if (wasSticky) { container.scrollTop = container.scrollHeight; }
        return bubble;
    }

    // Replace the streamed bubble's content with the authoritative full-turn
    // text carried by the terminal event. Covers replies that never streamed
    // (providers that stash the text in the reasoning trace) and any
    // divergence from a forced tool retry. Creates the bubble if no delta
    // ever arrived. Returns the bubble.
    function finalizeBubble(container, bubble, fullText) {
        if (!bubble) {
            return appendMessage(container, 'assistant', fullText);
        }
        bubble._mcpRaw = fullText;
        var span = bubble.querySelector('.mcp-assistant-text');
        if (span) { span.innerHTML = renderMarkdown(fullText); }
        return bubble;
    }

    // Swap the text of an existing typing indicator in place — the avatar and
    // its spinner keep animating instead of being torn down and rebuilt.
    function setTypingLabel(indicator, label) {
        if (!indicator) { return; }
        var span = indicator.querySelector('.mcp-assistant-text');
        if (span) { span.textContent = label || 'Thinking...'; }
    }

    function showTyping(container, label) {
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
        textSpan.textContent = label || 'Thinking...';

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
        renderMarkdown:    renderMarkdown,
        appendMessage:     appendMessage,
        appendDelta:       appendDelta,
        finalizeBubble:    finalizeBubble,
        showTyping:        showTyping,
        setTypingLabel:    setTypingLabel,
        showCompactingBar: showCompactingBar,
        setEmptyState:     setEmptyState,
        renderHero:        renderHero,
        removeHero:        removeHero,
        setHeroIdentity:   setHeroIdentity,
    };

})();
