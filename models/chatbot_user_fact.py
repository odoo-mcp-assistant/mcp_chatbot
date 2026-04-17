# -*- coding: utf-8 -*-
"""
chatbot_user_fact.py
--------------------
Stores durable facts about authenticated users. Each record is created by
the LLM through the `remember_fact` tool when it decides a statement is
worth keeping for future conversations.
"""

from odoo import fields, models


class ChatbotUserFact(models.Model):
    _name = "mcp.chatbot.user.fact"
    _description = "Chatbot User Fact"
    _order = "create_date desc"
    _rec_name = "fact_text"

    partner_id = fields.Many2one(
        "res.partner",
        string="User",
        required=True,
        ondelete="cascade",
        index=True,
        help="The authenticated user this fact belongs to.",
    )
    fact_text = fields.Text(
        string="Fact",
        required=True,
    )
    category = fields.Char(
        string="Category",
        default="general",
        help="Short label such as: preference, ecosystem, dislike, health, profession, lifestyle, general.",
    )
    create_date = fields.Datetime(
        string="Saved At",
        readonly=True,
    )
