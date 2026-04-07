import logging
from odoo import models

_logger = logging.getLogger(__name__)


class ProductTemplate(models.Model):
    _inherit = "product.template"

    def cron_publish_all_products(self):
        unpublished = self.search([("is_published", "=", False)])
        unpublished.write({"is_published": True})

    def cron_sync_internal_notes_to_ecommerce(self):
        products = self.search([])
        _logger.info("eCommerce sync: %d total products found", len(products))
        updated = 0
        for product in products:
            _logger.info(
                "Product '%s' — description: %r  website_description: %r",
                product.name, product.description, product.website_description,
            )
            if product.description:
                product.website_description = product.description
                updated += 1
        _logger.info("eCommerce sync: updated %d products", updated)

    def cron_complete_product_stock(self):
        all_storable = self.search([("type", "=", "product")])
        _logger.info("Stock cron: %d storable products found", len(all_storable))
        for t in all_storable:
            _logger.info("Product '%s' — type=%s  qty_available=%s", t.name, t.type, t.qty_available)
        location = self.env.ref("stock.stock_location_stock")
        StockQuant = self.env["stock.quant"]
        updated = 0
        for template in all_storable.filtered(lambda t: t.qty_available <= 0):
            for variant in template.product_variant_ids:
                StockQuant._update_available_quantity(variant, location, 150)
                updated += 1
        _logger.info("Stock cron: updated %d variants", updated)
