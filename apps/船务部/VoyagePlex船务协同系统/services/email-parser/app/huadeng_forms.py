"""Read the provided Huadeng cabinet/delivery forms, including merged mixed cartons."""
import re
from .warehouse_name import warehouse_name
from .attachments import _number, _text, _product_name_and_spec


def form_columns(rows):
    header = next((i for i, row in enumerate(rows) if len(row) >= 17 and '玩具' in _text(row[7]) and _text(row[4]) == '货号'), None)
    if header is None:
        return None, {}
    norm = lambda value: re.sub(r'[\s.#]+', '', _text(value)).lower()
    labels = [norm(value) for value in rows[header]]
    aliases = {
        'customer': ('洋行',), 'contract_number': ('合同',), 'product_code': ('货号',),
        'product_name': ('货名',), 'country': ('国家',), 'category': ('玩具类别',),
        'quantity': ('数量',), 'pieces': ('件数',), 'gross_weight': ('毛重',), 'net_weight': ('净重',),
        'volume': ('体积',), 'customer_po': ('客人PO#', '客PO'), 'order_total_pieces': ('每单总件数',),
        'order_total_quantity': ('每单总数量',), 'gross_weight_per_box': ('每箱毛重',),
        'net_weight_per_box': ('每箱净重',), 'net_net_weight_per_box': ('每箱净净重',),
        'customer_item_number': ('Customer PO item No.', 'Customer item No.'),
        'production_line': ('拉',), 'dimension_length': ('箱唛CM',),
    }
    return header, {key: next(index for index, label in enumerate(labels) if label in {norm(a) for a in names})
                    for key, names in aliases.items() if any(label in {norm(a) for a in names} for label in labels)}


def parse_huadeng_form(rows, merges):
    header, columns = form_columns(rows)
    marked = any(_text(row[0]) in {'华登', '兴信', '新信'} for row in rows if row)
    carton_marks = 'net_net_weight_per_box' in columns
    if header is None or not (marked or carton_marks and any(re.search(r'\bRR\b', ' '.join(map(_text, row)), re.I) for row in rows[:header])):
        return None

    def value(row, key):
        col = columns.get(key)
        return rows[row][col] if col is not None and col < len(rows[row]) else None

    def identity(row, key):
        col = columns.get(key)
        current = value(row, key)
        if col is None:
            return current
        value_at = current
        if value_at not in (None, ''):
            return value_at
        for r1, r2, c1, c2 in merges:
            if r1 <= row < r2 and c1 <= col < c2:
                return rows[r1][c1] if c1 < len(rows[r1]) else None
        return value_at

    items = []
    for r in range(header + 1, len(rows)):
        values = rows[r]
        if len(values) < 2 or _number(values[1]) is None:
            continue
        product = identity(r, 'product_code')
        if not product:
            continue
        name, spec = _product_name_and_spec(value(r, 'product_name'), None)
        group = next((f'mix-{r1+1}-{r2}' for r1, r2, c1, c2 in merges if columns.get('pieces') == c1 and r2-r1 > 1 and r1 <= r < r2), '')
        items.append({
            'product_code': _text(product), 'product_name': name, 'spec': spec,
            'contract_number': _text(identity(r, 'contract_number')), 'customer_po': _text(identity(r, 'customer_po')),
            'category': _text(value(r, 'category')), 'quantity': _number(value(r, 'quantity')), 'pieces': _number(value(r, 'pieces')),
            'gross_weight': _number(value(r, 'gross_weight')), 'net_weight': _number(value(r, 'net_weight')) if not carton_marks else None, 'volume': _number(value(r, 'volume')),
            'order_total_pieces': _number(identity(r, 'order_total_pieces')), 'gross_weight_per_box': _number(identity(r, 'gross_weight_per_box')),
            'net_weight_per_box': _number(value(r, 'net_weight_per_box')), 'packing_group': group, 'source_row': r+1,
        })
        if 'customer_item_number' in columns:
            items[-1]['customer_item_number'] = _text(identity(r, 'customer_item_number'))
        if carton_marks:
            start = columns.get('dimension_length')
            dims = [_text(values[c]) if c < len(values) else '' for c in range(start, start + 3)] if start is not None else []
            items[-1].update(net_net_weight=_number(value(r, 'net_weight')),
                             net_net_weight_per_box=_number(value(r, 'net_net_weight_per_box')),
                             order_total_quantity=_number(identity(r, 'order_total_quantity')),
                             production_line=_text(value(r, 'production_line')), box_dimensions='*'.join(dims) if len(dims) == 3 and all(dims) else '')
    flat = '\n'.join(' '.join(_text(v) for v in row) for row in rows)
    # Pallets are a separate line below cargo, not an additional product or weight.
    for r in range(header + 1, len(rows)):
        line = ' '.join(_text(v) for v in rows[r])
        match = re.search(r'(?<![\d.])(\d+)\s*(?:个\s*)?(?:卡板|托板|托盘)(?![\u4e00-\u9fff])', line)
        if match:
            previous = next((item for item in reversed(items) if item['source_row'] <= r + 1), None)
            if previous is not None:
                previous['pallet_count'] = int(match.group(1))
    so = re.search(r'SO\s*#\s*([A-Z0-9-]+)', flat, re.I)
    country = _text(value(items[0]['source_row'] - 1, 'country')) if items else ''
    from .rules import consignee_fields
    fields = {'destination_country': country, **consignee_fields(flat)}
    customer = _text(value(items[0]['source_row'] - 1, 'customer')) if items else ''
    fields['customer'] = customer
    brand = next((re.split(r'品牌\s*[：:]', _text(value), maxsplit=1)[-1].strip() for row in rows for value in row if re.search(r'品牌\s*[：:]', _text(value))), '')
    fields['brand'] = brand
    top = '\n'.join(' '.join(_text(v) for v in row) for row in rows[:header])
    fields['pickup_note'] = ' '.join(dict.fromkeys(_text(value) for row in rows[:header] for value in row
        if re.search(r'客自提|客上柜|客上车|报关行|带卡板走货', _text(value))))
    sequence = re.search(r'(\d+)\s*(柜|车)', top)
    if sequence:
        fields['sequence_number'] = sequence.group(1)
        fields['shipment_mode'] = 'Warehouse' if sequence.group(2) == '车' else 'Container'
    vehicle = re.search(r'\d+\s*[*xX]\s*\d+\s*T\b', top, re.I)
    if vehicle:
        fields['vehicle_type'] = re.sub(r'\s+', '', vehicle.group())
    warehouse = warehouse_name('\n'.join(' '.join(_text(v) for v in row) for row in rows[:header]))
    if warehouse:
        fields.update(warehouse=warehouse, delivery_address=warehouse)
    if so:
        fields['so_number'] = so.group(1)
    return {'kind':'huadeng_shipment_form', 'fields':fields, 'items':items, 'warnings':[] if items else ['走货表没有识别到货物明细']}
