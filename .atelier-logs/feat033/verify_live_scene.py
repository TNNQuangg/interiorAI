import json
import urllib.request
from pathlib import Path
folder = Path(__file__).parent
before=json.loads((folder/'bedroom-before.json').read_text(encoding='utf-8-sig'))
url='http://127.0.0.1:8000/api/v1/projects/proj_bedroom_japandi_4x4m'
with urllib.request.urlopen(url) as response:
    after=json.load(response)
(folder/'bedroom-after.json').write_text(json.dumps(after,ensure_ascii=False,indent=2),encoding='utf-8')
old={x['id']:x for x in before['furniture_instances']}
new={x['id']:x for x in after['furniture_instances']}
assert len(new)==len(old)+1==8
assert set(new)-set(old)=={'bench_atl15_japandi'}
for key,value in old.items():
    assert {k:v for k,v in value.items() if k!='pascal_node_id'} == {k:v for k,v in new[key].items() if k!='pascal_node_id'},key
for key in ('rooms','walls','openings','windows'):
    assert before.get(key)==after.get(key),key
bench=new['bench_atl15_japandi']
scene=after['pascal_scene_json']
node=scene['nodes'][bench['pascal_node_id']]
assert scene['atelier_addition']['addition']['collision_ids']==[]
assert scene['atelier_addition']['addition']['solid_clearances_mm']['wardrobe_full_height']==790
assert scene['atelier_addition']['pascal_verification']['valid'] is True
evidence={'project_id':after['project_id'],'revision':after['revision'],'furniture_count':len(new),'original_furniture_preserved':True,'room_shell_preserved':True,'bench':bench,'pascal_node':node,'addition_validation':scene['atelier_addition']['addition'],'price_status':scene['atelier_addition']['price_status'],'mcp_issue_types':[x['type'] for x in scene['atelier_addition']['pascal_verification']['issues']]}
(folder/'live-scene-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(evidence,ensure_ascii=True))
