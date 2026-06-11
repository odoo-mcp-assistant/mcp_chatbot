# -*- coding: utf-8 -*-
"""
chatbot_usage.py
----------------
Per-identity daily token accounting for the chatbot.

One row per (identity, day). The FastAPI sidecar increments these rows
after each chat turn — summing the `usage.total_tokens` reported by every
LLM call in that turn (agent rounds + intent classifier + summary) — and
reads them *before* a turn to enforce a per-user daily token budget.

Identity is a single string key so authenticated and anonymous callers
share one table:
  - logged-in users → "partner:<id>"
  - anonymous users → "ip:<address>"

Anonymous callers are keyed by IP, not by their session_token: the token
is a self-generated UUID they can rotate for free, so it cannot bound
spend — the source IP is their only scarce identifier. (Same keying as
the sidecar's rate limiter, on purpose.)

The budgets themselves live in ir.config_parameter and are enforced in
the sidecar; this model is pure storage + atomic accumulation. The window
is a calendar day in UTC (fields.Date.today), so quotas reset at UTC
midnight.
"""

from odoo import api, fields, models


class ChatbotUsage(models.Model):
    _name = "mcp.chatbot.usage"
    _description = "Chatbot Token Usage (per identity, per day)"
    _order = "usage_date desc, total_tokens desc"
    _rec_name = "identity_key"

    identity_key = fields.Char(
        string="Identity Key",
        required=True,
        index=True,
        help='Caller bucket: "partner:<id>" for logged-in users, '
             '"ip:<address>" for anonymous visitors.',
    )
    usage_date = fields.Date(
        string="Date (UTC)",
        required=True,
        index=True,
        default=fields.Date.today,
    )
    total_tokens = fields.Integer(
        string="Tokens Used",
        default=0,
        help="Sum of total_tokens reported by every LLM call billed to "
             "this identity on this day (agent rounds + classifier + summary).",
    )
    message_count = fields.Integer(
        string="Messages",
        default=0,
        help="Number of chat turns this identity sent on this day.",
    )
    partner_id = fields.Many2one(
        "res.partner",
        string="User",
        ondelete="set null",
        index=True,
        help="Set for logged-in callers (display only).",
    )
    ip_address = fields.Char(
        string="IP Address",
        help="Set for anonymous callers (display only).",
    )

    _sql_constraints = [
        (
            "identity_day_uniq",
            "unique(identity_key, usage_date)",
            "Only one usage row per identity per day is allowed.",
        ),
    ]

    @api.model
    def get_today_tokens(self, identity_key):
        """Return tokens already used today by this identity (0 if none).

        Called by the sidecar before a turn to compare against the budget.
        """
        if not identity_key:
            return 0
        rec = self.search([
            ("identity_key", "=", identity_key),
            ("usage_date", "=", fields.Date.today()),
        ], limit=1)
        return rec.total_tokens if rec else 0

    @api.model
    def record_usage(self, identity_key, tokens, partner_id=False, ip_address=False):
        """Add `tokens` to today's row for this identity (creating it if
        needed) and bump the message counter. Returns the new running total.

        The get-or-create + increment run inside this single Odoo
        transaction, so the read-modify-write is consistent for the (low)
        per-identity concurrency we expect — a given caller is already
        serialised by the sidecar's rate limiter.
        """
        if not identity_key:
            return 0
        tokens = max(int(tokens or 0), 0)
        today = fields.Date.today()
        rec = self.search([
            ("identity_key", "=", identity_key),
            ("usage_date", "=", today),
        ], limit=1)
        if rec:
            rec.write({
                "total_tokens": rec.total_tokens + tokens,
                "message_count": rec.message_count + 1,
            })
            return rec.total_tokens
        rec = self.create({
            "identity_key": identity_key,
            "usage_date": today,
            "total_tokens": tokens,
            "message_count": 1,
            "partner_id": partner_id or False,
            "ip_address": ip_address or False,
        })
        return rec.total_tokens
