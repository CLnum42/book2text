"""index 视图迁移的替换口径（任务 94 · Slice I1）。

与 preview-p2/rules.py 的差别（有意加强，已记进 NOTES.md）：
**替换只在"代码区"内发生** —— `code_mask()` 把注释、字符串、模板字面量的文本部分
标成不可替换，但**保留 `${…}` 里的表达式**（那才是真的代码）。
preview 版只屏蔽注释，字符串内部的同名标识符也会被替换；这次不给自己留那个口子。

口径来源：对 `#view-index` 段（app.js 8185–9343）跑标识符分析，段外用到、
段内有定义的接缝共 25 个；减去 `el`（模块自带）和 `currentView`（走 isActive 注入），
再减去三个留在 app.js 的纯数据服务与图片清晰度簇里的读点，得下表。
"""

# 整句替换：先于标识符替换执行，按"长的在前"排。
LIT = [
    ('el("pages-overlay-toggle")', 'injected.getPagesOverlayToggle()'),
    ('el("pages-margin-toggle")', 'injected.getPagesMarginToggle()'),
    ('currentView === "index"', 'injected.isActive()'),
    ('currentView !== "index"', '!injected.isActive()'),
    ('pagesOverlayOn = true;', 'injected.setPagesOverlayOn(true);'),
    ('pagesMarginOn = true;', 'injected.setPagesMarginOn(true);'),
    ('pageZoomIndex = next;', 'injected.setPageZoomIndex(next);'),
    ('pageZoomTouched = true;', 'injected.setPageZoomTouched(true);'),
]

# 标识符替换。左边界 `(?<![\w$.])` 挡住属性访问与已经注入过的名字。
IDENT = [
    ('INDEX_IMAGE_WINDOW', 'injected.imageWindow'),
    ('INDEX_ZOOM_SCALES', 'injected.zoomScales'),
    ('apiJson', 'injected.apiJson'),
    ('blockCountedInMargin', 'injected.blockCountedInMargin'),
    ('clearImagePlaceholder', 'injected.clearImagePlaceholder'),
    ('clearPageBlocks', 'injected.clearPageBlocks'),
    ('clearTileMargin', 'injected.clearTileMargin'),
    ('currentProject', 'injected.getProject()'),
    ('detailPageNo', 'injected.getDetailPageNo()'),
    ('goToWorkflowStep', 'injected.goToWorkflowStep'),
    ('imageQualityMode', 'injected.getImageQualityMode()'),
    ('loadIndexBlocks', 'injected.loadIndexBlocks'),
    ('loadPageIndex', 'injected.loadPageIndex'),
    ('pageBlockCache', 'injected.pageBlockCache'),
    ('pageBlockKey', 'injected.pageBlockKey'),
    ('pageImageUrl', 'injected.pageImageUrl'),
    ('pageIndexData', 'injected.getPageIndexData()'),
    ('pageIndexProject', 'injected.getPageIndexProject()'),
    ('pageProfileFor', 'injected.pageProfileFor'),
    ('pageZoomIndex', 'injected.getPageZoomIndex()'),
    ('pagesMarginOn', 'injected.getPagesMarginOn()'),
    ('pagesOverlayOn', 'injected.getPagesOverlayOn()'),
    ('paintTileMargin', 'injected.paintTileMargin'),
    ('rememberPageBlocks', 'injected.rememberPageBlocks'),
    ('renderPageBlocks', 'injected.renderPageBlocks'),
    ('savePageMarginPreference', 'injected.savePageMarginPreference'),
    ('savePageOverlayPreference', 'injected.savePageOverlayPreference'),
    ('setImageQuality', 'injected.setImageQuality'),
    ('toggleMarginView', 'injected.toggleMarginView'),
    ('togglePageBlocksOverlay', 'injected.togglePageBlocksOverlay'),
]

import re

# 段内声明、留段外的白名单（analyzer 用）。
STAY_DECLS = {
    'pageIndexData', 'pageIndexProject', 'pageIndexLoading',
    'INDEX_ZOOM_SCALES', 'INDEX_IMAGE_WINDOW',
    'loadPageIndex', 'loadIndexBlocks', 'clearImagePlaceholder',
    'IMAGE_QUALITY_LABELS', 'loadImageQuality', 'setImageQuality', 'syncImageQualityUi',
}

# 注入面的期望键（analyzer / verify 用；少一个多一个都要报）。
EXPECTED_KEYS = {
    'isActive', 'getProject', 'getDetailPageNo', 'getImageQualityMode', 'setImageQuality',
    'getPageZoomIndex', 'setPageZoomIndex', 'setPageZoomTouched',
    'getPagesMarginOn', 'setPagesMarginOn', 'getPagesOverlayOn', 'setPagesOverlayOn',
    'getPagesMarginToggle', 'getPagesOverlayToggle',
    'savePageMarginPreference', 'savePageOverlayPreference',
    'togglePageBlocksOverlay', 'toggleMarginView',
    'getPageIndexData', 'getPageIndexProject', 'getPageIndexLoading',
    'loadPageIndex', 'loadIndexBlocks',
    'clearImagePlaceholder', 'goToWorkflowStep',
    'pageImageUrl', 'pageProfileFor', 'blockCountedInMargin',
    'clearPageBlocks', 'clearTileMargin', 'paintTileMargin', 'renderPageBlocks',
    'zoomScales', 'imageWindow',
}


def code_mask(s):
    """True = 可替换（代码区，含模板 `${…}` 内的表达式）。

    与 preview-p2 的 `comment_mask` 不同：字符串与模板文本也算不可替换。
    """
    mask = [False] * len(s)
    n = len(s)

    def mark(a, b):
        for k in range(a, min(b, n)):
            mask[k] = True

    i = 0
    while i < n:
        c = s[i]
        nx = s[i + 1] if i + 1 < n else ''
        if c == '/' and nx == '/':
            j = s.find('\n', i)
            i = n if j < 0 else j
        elif c == '/' and nx == '*':
            j = s.find('*/', i + 2)
            i = n if j < 0 else j + 2
        elif c in '"\'':
            q = c
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == q:
                    j += 1
                    break
                j += 1
            i = j
        elif c == '`':
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == '`':
                    j += 1
                    break
                if s[j] == '$' and j + 1 < n and s[j + 1] == '{':
                    k = j + 2
                    d = 1
                    while k < n and d > 0:
                        ch = s[k]
                        if ch == '{':
                            d += 1
                        elif ch == '}':
                            d -= 1
                        elif ch in '"\'':
                            q = ch
                            k += 1
                            while k < n:
                                if s[k] == '\\':
                                    k += 2
                                    continue
                                if s[k] == q:
                                    break
                                k += 1
                        elif ch == '`':
                            k += 1
                            while k < n:
                                if s[k] == '\\':
                                    k += 2
                                    continue
                                if s[k] == '`':
                                    break
                                k += 1
                        k += 1
                    # `${ … }`：表达式本体递归标成代码区
                    inner = s[j + 2:k - 1]
                    inner_mask = code_mask(inner)
                    for off, ok in enumerate(inner_mask):
                        if ok:
                            mask[j + 2 + off] = True
                    j = k
                    continue
                j += 1
            i = j
        else:
            mask[i] = True
            i += 1
    return mask


def sub_checked(text, pattern, rep):
    mask = code_mask(text)
    out = []
    last = 0
    for m in re.finditer(pattern, text):
        if m.start() < len(mask) and mask[m.start()]:
            out.append(text[last:m.start()])
            out.append(rep)
            last = m.end()
    out.append(text[last:])
    return ''.join(out)


def forward(text):
    for lit, rep in LIT:
        text = sub_checked(text, re.escape(lit), rep)
    for ident, rep in IDENT:
        text = sub_checked(text, r'(?<![\w$.])' + re.escape(ident) + r'\b', rep)
    return text


def backward(text):
    pairs = [(rep, lit) for lit, rep in LIT] + [(rep, i) for i, rep in IDENT]
    pairs.sort(key=lambda p: -len(p[0]))
    for new, old in pairs:
        text = sub_checked(text, re.escape(new), old)
    return text


def strip_code(s):
    """去注释 / 去字符串 / 去模板文本，保留 `${…}` 表达式（analyzer 与 R1 镜像用）。"""
    mask = code_mask(s)

    def strict(a, b):
        # 只保留代码区；字符串/注释/模板文本一律抹成空白
        return ''.join(
            ch if (mask[k] or ch == '\n') else ' '
            for k, ch in enumerate(s[a:b], start=a)
        )

    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        nx = s[i + 1] if i + 1 < n else ''
        if c == '/' and nx == '/':
            j = s.find('\n', i)
            j = n if j < 0 else j
            out.append(strict(i, j))
            i = j
        elif c == '/' and nx == '*':
            j = s.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(strict(i, j))
            i = j
        elif c in '"\'':
            q = c
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == q:
                    j += 1
                    break
                j += 1
            out.append(strict(i, j))
            i = j
        elif c == '`':
            j = i + 1
            while j < n:
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == '`':
                    j += 1
                    break
                if s[j] == '$' and j + 1 < n and s[j + 1] == '{':
                    k = j + 2
                    d = 1
                    while k < n and d > 0:
                        ch = s[k]
                        if ch == '{':
                            d += 1
                        elif ch == '}':
                            d -= 1
                        elif ch in '"\'':
                            q = ch
                            k += 1
                            while k < n:
                                if s[k] == '\\':
                                    k += 2
                                    continue
                                if s[k] == q:
                                    break
                                k += 1
                        elif ch == '`':
                            k += 1
                            while k < n:
                                if s[k] == '\\':
                                    k += 2
                                    continue
                                if s[k] == '`':
                                    break
                                k += 1
                        k += 1
                    out.append(strict(i, j + 2))
                    out.append(strip_code(s[j + 2:k - 1]))
                    out.append('}')
                    j = k
                    continue
                j += 1
            out.append(strict(i, j))
            i = j
        else:
            out.append(c)
            i += 1
    return ''.join(out)
