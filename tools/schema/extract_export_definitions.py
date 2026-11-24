import ast,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=subprocess.check_output(['git','show','origin/main:backend/app/services/exports.py'],cwd=root,text=True)
values={'True':True,'False':False,'None':None}
fields=['name','label','description','scope','permission','headers','query','row','date_label','statuses','needs_month','contains_personal_data','date_optional','filters','pdf_columns']
def evaluate(n):
    if isinstance(n,ast.Constant):return n.value
    if isinstance(n,(ast.List,ast.Tuple)):return [evaluate(e) for e in n.elts]
    if isinstance(n,ast.Dict):return {evaluate(k):evaluate(v) for k,v in zip(n.keys,n.values)}
    if isinstance(n,ast.Name):return values.get(n.id,None)
    if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='ExportSpec':
        out=dict(zip(fields,[evaluate(a) for a in n.args]));out.update({k.arg:evaluate(k.value) for k in n.keywords});out.pop('query');out.pop('row');return out
    raise ValueError(ast.dump(n))
for node in ast.parse(source).body:
    if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name):
        name=node.targets[0].id
        if name=='FILTERS' or name.endswith('_HEADERS') or name in ['SUB_STATUSES','RETURN_STATUSES','PAYOUT_STATUSES','_ORD','_ORD_PDF','_ITEM_PDF','_PROD_STATUSES','_PROD_PDF']:values[name]=evaluate(node.value)
    if isinstance(node,ast.AnnAssign) and isinstance(node.target,ast.Name):
        if node.target.id in ['FILTERS','_ALL']:values[node.target.id]=evaluate(node.value)
output={'filters':values['FILTERS'],'specs':values['_ALL']}
p=root/'PixCartAPI/Utils/Assets/export-definitions.json';p.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n');print(len(output['specs']),p)
