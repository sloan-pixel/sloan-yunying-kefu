# 把 使用说明.md 转成单文件 使用说明.html（图片内嵌，发给同事直接双击打开）
# 运行：python3 docs/build_html.py
import base64, html, os, re, markdown
D = os.path.dirname(os.path.abspath(__file__))
md = open(os.path.join(D, '使用说明.md'), encoding='utf-8').read()
body = markdown.markdown(md, extensions=['tables', 'toc'])
def inline(m):
    p = os.path.join(D, html.unescape(m.group(1)))
    b = base64.b64encode(open(p, 'rb').read()).decode()
    return f'src="data:image/jpeg;base64,{b}"'
body = re.sub(r'src="(img/[^"]+)"', inline, body)
css = ('body{font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1b2430;max-width:900px;margin:32px auto;padding:0 20px}'
       'h1{font-size:26px}h2{font-size:20px;margin-top:36px;border-bottom:1px solid #dfe4ea;padding-bottom:4px}h3{font-size:17px;margin-top:26px}'
       'table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}th,td{border:1px solid #dfe4ea;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f6f8fa}'
       'code{background:#f0f2f5;padding:1px 5px;border-radius:3px}img{max-width:100%;border:1px solid #dfe4ea;border-radius:8px;margin:8px 0;box-shadow:0 2px 10px rgba(0,0,0,.06)}'
       'p:has(>img){text-align:center}')
out = f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sloan云盈客服助手 使用说明</title><style>{css}</style></head><body>{body}</body></html>'
open(os.path.join(D, '使用说明.html'), 'w', encoding='utf-8').write(out)
print('ok', len(out) // 1024, 'KB')
