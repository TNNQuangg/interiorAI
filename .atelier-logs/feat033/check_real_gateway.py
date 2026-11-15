import asyncio
import json
import sys
import urllib.request
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'apps' / 'api'))
from app.models.contracts import CanonicalProject, FurnitureInstance
from app.services.mcp_gateway import sync_canonical_to_pascal
with urllib.request.urlopen('http://127.0.0.1:8000/api/v1/projects/proj_bedroom_japandi_4x4m') as response:
    project = CanonicalProject.model_validate(json.load(response))
if not any(x.id == 'bench_atl15_japandi' for x in project.furniture_instances):
    project.furniture_instances.append(FurnitureInstance(id='bench_atl15_japandi',room_id=project.rooms[0].id,sku='CUSTOM-BENCH-ATL15',name='Japandi upholstered bench',category='bench',x_mm=2095,y_mm=2450,z_mm=0,width_mm=1200,depth_mm=400,height_mm=450,rotation_deg=0,color_hex='#D5CBBF',price_vnd=0,pascal_asset_id='custom-authored-bench'))
result=asyncio.run(sync_canonical_to_pascal(project))
(Path(__file__).parent / 'real-gateway-result.json').write_text(json.dumps(result, ensure_ascii=False),encoding='utf-8')
print(json.dumps({k:result.get(k) for k in ['ok','error','verification','collisions','furnitureNodeIds','geometryRepresentation']},ensure_ascii=True))
