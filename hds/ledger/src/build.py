"""HDS 안전장부 빌드: template.html 에 forms.json 을 넣어 단일 HTML 을 만든다."""
import json, pathlib
here = pathlib.Path(__file__).resolve().parent
data = json.loads((here / 'forms.json').read_text(encoding='utf-8'))
blob = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
html = (here / 'template.html').read_text(encoding='utf-8').replace('/*__FORMS__*/', blob)
out = here.parent / 'hds-safety-ledger.html'
out.write_text(html, encoding='utf-8')
print(out, len(html.encode('utf-8')) // 1024, 'KB')
