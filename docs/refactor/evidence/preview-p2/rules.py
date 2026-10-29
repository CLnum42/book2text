import re
LIT = [
    ('pagesMarginOn = true;', 'injected.setPagesMarginOn(true);'),
    ('pagesOverlayOn = true;', 'injected.setPagesOverlayOn(true);'),
    ('pageZoomIndex = next;', 'injected.setPageZoomIndex(next);'),
    ('pageZoomTouched = true;', 'injected.setPageZoomTouched(true);'),
    ('el("pages-margin-toggle")', 'injected.getPagesMarginToggle()'),
    ('el("pages-overlay-toggle")', 'injected.getPagesOverlayToggle()'),
    ('currentView !== "preview"', '!injected.isActive()'),
]
IDENT = [
    ('BLOCK_TYPE_LABELS','injected.blockTypeLabels'),
    ('INDEX_ZOOM_SCALES','injected.zoomScales'),
    ('apiJson','injected.apiJson'),
    ('applyBoxElementRect','injected.applyBoxElementRect'),
    ('clearPageBlocks','injected.clearPageBlocks'),
    ('clearTileMargin','injected.clearTileMargin'),
    ('currentProject','injected.getProject()'),
    ('detailPageNo','injected.getDetailPageNo()'),
    ('exportOptions','injected.exportOptions'),
    ('loadIndexBlocks','injected.loadIndexBlocks'),
    ('loadPageIndex','injected.loadPageIndex'),
    ('pageImageUrl','injected.pageImageUrl'),
    ('pageIndexData','injected.getPageIndexData()'),
    ('pageIndexLoading','injected.getPageIndexLoading()'),
    ('pageIndexProject','injected.getPageIndexProject()'),
    ('pageProfileFor','injected.pageProfileFor'),
    ('pageZoomIndex','injected.getPageZoomIndex()'),
    ('pagesMarginOn','injected.getPagesMarginOn()'),
    ('pagesOverlayOn','injected.getPagesOverlayOn()'),
    ('paintTileMargin','injected.paintTileMargin'),
    ('renderPageBlocks','injected.renderPageBlocks'),
    ('savePageMarginPreference','injected.savePageMarginPreference'),
    ('savePageOverlayPreference','injected.savePageOverlayPreference'),
    ('syncIndexToggles','injected.syncIndexToggles'),
    ('toggleMarginView','injected.toggleMarginView'),
    ('togglePageBlocksOverlay','injected.togglePageBlocksOverlay'),
]
def comment_mask(s):
    mask=[True]*len(s); i=0; n=len(s)
    while i<n:
        c=s[i]; nx=s[i+1] if i+1<n else ''
        if c=='/' and nx=='/':
            j=s.find('\n',i); j=n if j<0 else j
            for k in range(i,j): mask[k]=False
            i=j
        elif c=='/' and nx=='*':
            j=s.find('*/',i+2); j=n if j<0 else j+2
            for k in range(i,j): mask[k]=False
            i=j
        elif c in '"\'':
            q=c; i+=1
            while i<n:
                if s[i]=='\\': i+=2; continue
                if s[i]==q: i+=1; break
                i+=1
        elif c=='`':
            i+=1
            while i<n:
                if s[i]=='\\': i+=2; continue
                if s[i]=='`': i+=1; break
                i+=1
        else: i+=1
    return mask
def sub_checked(text, pattern, rep):
    mask=comment_mask(text); out=[]; last=0
    for m in re.finditer(pattern, text):
        if m.start()<len(mask) and mask[m.start()]:
            out.append(text[last:m.start()]); out.append(rep); last=m.end()
    out.append(text[last:]); return ''.join(out)
def forward(text):
    for lit,rep in LIT: text=sub_checked(text, re.escape(lit), rep)
    for ident,rep in IDENT: text=sub_checked(text, r'(?<![\w$.])'+re.escape(ident)+r'\b', rep)
    return text
def backward(text):
    pairs=[(rep,lit) for lit,rep in LIT]+[(rep,i) for i,rep in IDENT]
    pairs.sort(key=lambda p:-len(p[0]))
    for new,old in pairs: text=sub_checked(text, re.escape(new), old)
    return text

def strip_code(s):
    """去注释 / 去字符串 / 去模板字面量的文本部分，**保留 `${…}` 里的表达式**。

    为什么不用 boundary.test.mjs 的 stripCommentsAndStrings：它把整个模板（含 ${}）抹掉，
    于是 `renderPreview` 里 `` `${BLOCK_TYPE_LABELS[type]} …` `` 这种依赖会漏检
    （实测：第一版扫描漏了 BLOCK_TYPE_LABELS，是这条 R1 盲区）。
    """
    out = []; i = 0; n = len(s)
    def blank(seg):
        return ''.join(ch if ch == '\n' else ' ' for ch in seg)
    while i < n:
        c = s[i]; nx = s[i+1] if i+1 < n else ''
        if c == '/' and nx == '/':
            j = s.find('\n', i); j = n if j < 0 else j
            out.append(blank(s[i:j])); i = j
        elif c == '/' and nx == '*':
            j = s.find('*/', i+2); j = n if j < 0 else j+2
            out.append(blank(s[i:j])); i = j
        elif c in '"\'':
            q = c; j = i+1
            while j < n:
                if s[j] == '\\': j += 2; continue
                if s[j] == q: j += 1; break
                j += 1
            out.append(blank(s[i:j])); i = j
        elif c == '`':
            j = i+1; buf = []
            while j < n:
                if s[j] == '\\': j += 2; continue
                if s[j] == '`': j += 1; break
                if s[j] == '$' and j+1 < n and s[j+1] == '{':
                    k = j+2; d = 1
                    while k < n and d > 0:
                        ch = s[k]
                        if ch == '{': d += 1
                        elif ch == '}': d -= 1
                        elif ch in '"\'':
                            q = ch; k += 1
                            while k < n:
                                if s[k] == '\\': k += 2; continue
                                if s[k] == q: break
                                k += 1
                        elif ch == '`':
                            k += 1
                            while k < n:
                                if s[k] == '\\': k += 2; continue
                                if s[k] == '`': break
                                k += 1
                        k += 1
                    buf.append(' ' + strip_code(s[j+2:k-1]) + ' ')
                    j = k; continue
                j += 1
            out.append(''.join(buf)); i = j
        else:
            out.append(c); i += 1
    return ''.join(out)
