from odoo import models, fields



class McpLlmProvider(models.Model):
    _name = 'mcp.llm.provider'




    name = fields.Char(string="Provider Name", required=True)
    mcp_llm_model_ids = fields.One2many(
        'mcp.llm.model',
        'provider_id'
    )