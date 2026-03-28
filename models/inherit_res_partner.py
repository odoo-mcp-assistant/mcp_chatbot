from odoo import models, fields




class ResPartner(models.Model):
    _inherit = 'res.partner'



    user_fact_ids = fields.One2many('mcp.chatbot.user.fact', 'partner_id')
    chatbot_session_ids = fields.One2many('mcp.chatbot.session', 'partner_id')