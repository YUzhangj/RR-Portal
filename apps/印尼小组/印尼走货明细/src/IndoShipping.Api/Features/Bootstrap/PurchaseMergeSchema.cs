namespace IndoShipping.Api.Features.Bootstrap;

public static class PurchaseMergeSchema
{
    public const string SchemaSql = """
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS merged_into_id INT NULL;
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS merge_revision INT NOT NULL DEFAULT 0;
        ALTER TABLE po_items ADD COLUMN IF NOT EXISTS source_po_no TEXT NULL;
        ALTER TABLE po_items ADD COLUMN IF NOT EXISTS source_delivery_date DATE NULL;
        ALTER TABLE po_items ADD COLUMN IF NOT EXISTS delivery_date_override DATE NULL;
        ALTER TABLE po_items ADD COLUMN IF NOT EXISTS has_delivery_date_override BOOLEAN NOT NULL DEFAULT FALSE;
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='po_items'::regclass
                AND attname='source_order_date' AND NOT attisdropped) THEN
                ALTER TABLE po_items ADD COLUMN source_order_date DATE NULL;
                UPDATE po_items i SET source_order_date=p.order_date
                    FROM purchase_orders p WHERE i.source_po_no=p.po_no;
            END IF;
        END $$;
        CREATE INDEX IF NOT EXISTS ix_purchase_orders_merged_into ON purchase_orders(merged_into_id)
            WHERE merged_into_id IS NOT NULL;
        """;
}
