# -*- coding: utf-8 -*-
"""
chatbot_user_fact.py
--------------------
Mirrors every fact stored in ChromaDB into the Odoo database so that
admins can inspect, edit, or delete facts directly from the backend UI.

Each record represents one durable fact extracted from a conversation turn
and linked to the res.partner that owns it.
"""

import logging

from odoo import fields, models

_logger = logging.getLogger(__name__)


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
        help="The extracted fact text, as stored verbatim in ChromaDB.",
    )
    category = fields.Char(
        string="Category",
        default="general",
        help="Category label returned by the LLM extractor (e.g. preference, personal, etc.).",
    )
    chroma_doc_id = fields.Char(
        string="ChromaDB Document ID",
        readonly=True,
        help="MD5 hash used as the document ID in ChromaDB — useful for cross-referencing.",
    )
    create_date = fields.Datetime(
        string="Extracted At",
        readonly=True,
    )
