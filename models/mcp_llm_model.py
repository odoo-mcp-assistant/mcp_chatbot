from odoo import fields, models




class McpLlmModel(models.Model):
    _name = 'mcp.llm.model'
    _description = 'LLM Model'
    _order = 'name asc'



    name = fields.Char(
        string='Model Name',
        required=True,
        help="The technical model identifier used in API calls e.g. llama-3.3-70b-versatile",
    )

    display_name_label = fields.Char(
        string='Label',
        help="Human-readable label shown in the UI e.g. Llama 3.3 70B Versatile",
    )

    provider_id = fields.Many2one(
        'mcp.llm.provider',
        string="Provider"
    )

    active = fields.Boolean(default=True)