from io import BytesIO
import unittest
from openpyxl import load_workbook
from app.warehouse_truck import recommend_truck, warehouse_truck_type
from app.shipment_export import build_shipment_workbook


class WarehouseTruckTests(unittest.TestCase):
    def test_continuous_bands_and_invalid_volume(self):
        for volume, tonnes in [(1,3),(10,3),(10.5,5),(16,5),(16.1,8),(20,8),(20.5,10),(30,10),(30.1,12),(39,12),(39.1,18),(50,18)]:
            with self.subTest(volume=volume):
                self.assertEqual(f'1*{tonnes}T', recommend_truck([{'volume':volume}]))
        for value in [None,'',0,-1,'bad',float('nan'),51]:
            self.assertEqual('',recommend_truck([{'volume':value}]))
        self.assertEqual('',recommend_truck([{'volume':1},{}]))

    def test_confirmed_shared_volume_counted_once(self):
        self.assertEqual('1*3T',recommend_truck([{'volume':8,'packing_group':'A'},{'volume':8,'packing_group':'A'}]))
        self.assertEqual('',recommend_truck([{'volume':8,'packing_group':'A'},{'volume':9,'packing_group':'A'}]))

    def test_manual_override_and_recommendation_refresh(self):
        items=[{'volume':20}]
        self.assertEqual('1*5T',warehouse_truck_type({'containerType':'5吨','exportDetails':{'truckTypeSource':'manual'}},items))
        self.assertEqual('1*8T',warehouse_truck_type({'containerType':'1*3T','exportDetails':{'truckTypeSource':'recommended'}},items))
        with self.assertRaises(ValueError):
            warehouse_truck_type({'containerType':'bad','exportDetails':{'truckTypeSource':'manual'}},items)

    def test_warehouse_header_and_container_unchanged(self):
        task={'company':'Xingxin','customer':'ZURU','containerType':'1*40HQ','plannedShipDate':'2026-08-03','items':[{'volume':3}],'exportDetails':{'shipmentMode':'Warehouse','warehouse':'八达仓'}}
        def sheet():
            result=build_shipment_workbook(task)
            return load_workbook(BytesIO(result[0] if isinstance(result,tuple) else result)).active
        self.assertIn('入八达仓 1*3T 吨车如下：各',sheet()['E3'].value)
        task['items']=[{'volume':51}]
        self.assertIn('吨车待人工确认',sheet()['E3'].value)
        task['exportDetails']['shipmentMode']='Container'
        self.assertIn('1*40HQ',sheet()['E3'].value)
