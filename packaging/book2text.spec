# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（说明书 Phase 6：macOS arm64 与 Windows x64 各打一份）。

**怎么用：**

    macOS：scripts/build_macos.sh        → dist/Book2Text.app
    Windows：scripts\\build_windows.bat  → dist\\Book2Text\\Book2Text.exe

**为什么是 onedir（而不是 onefile）：** 识别跑在**子进程**里，子进程的命令是
`<同一个可执行文件> --b2t-worker ...`（见 `book2text/main.py` 的 WORKER_FLAG）。
onefile 每次启动都会解包到临时目录，父子进程解包路径不同，既慢又容易踩坑；
onedir 是稳定的一条路。

**模型与依赖：** 识别依赖 `rapidocr` + `onnxruntime`（约 300 MB，说明书 8.4 要求
"模型文件随安装包内置"）。它们装在 `ocr-eval` 依赖组里，只有装了才会被打进去；
没装也能打包，只是识别会如实报"引擎不可用"（说明书 1.6：不假装可用）。

**未签名：** 打出来的包没有代码签名。macOS 上首次打开要右键 →「打开」；
Windows 上会出现 SmartScreen 提示（更多信息 → 仍要运行）。见两份用户手册。
"""

from pathlib import Path

REPO_ROOT = Path(SPECPATH).resolve().parent
STATIC_DIR = REPO_ROOT / "backend" / "book2text" / "static"

block_cipher = None

# 静态界面随包带上：说明书 6.1 的界面由后端托管，没有它应用打不开
datas = [(str(STATIC_DIR), "book2text/static")]
binaries = []

hiddenimports = [
    "book2text.worker",          # 子进程入口（--b2t-worker 时导入）
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# OCR 依赖（装了才收集；没装则如实显示"引擎不可用"）
for package in ("rapidocr", "onnxruntime", "pyclipper", "shapely", "PIL"):
    try:
        __import__(package)
    except ImportError:
        continue
    hiddenimports.append(package)

# rapidocr 与 onnxruntime 带数据文件与动态库：**在 Analysis 之前**整包收集
# （PyInstaller 6 的 TOC 是三元组，事后往 a.datas 追加两元组会报
# "not enough values to unpack"）
for package in ("rapidocr", "onnxruntime"):
    try:
        from PyInstaller.utils.hooks import collect_all

        collected_datas, collected_binaries, collected_hidden = collect_all(package)
    except ImportError:  # pragma: no cover - 没装这个包
        continue
    datas += collected_datas
    binaries += collected_binaries
    hiddenimports += collected_hidden

binaries = list(binaries)

a = Analysis(
    [str(REPO_ROOT / "packaging" / "entry.py")],
    pathex=[str(REPO_ROOT / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "tkinter", "matplotlib", "IPython"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Book2Text",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,          # 保留控制台：启动地址、任务日志都打在这里，用户要求助时能看见
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Book2Text",
)

# macOS：再包一层 .app，双击即启动（Windows 上这段会被 PyInstaller 忽略）
app = BUNDLE(
    coll,
    name="Book2Text.app",
    icon=None,
    bundle_identifier="local.book2text",
    info_plist={
        "CFBundleName": "Book2Text",
        "CFBundleDisplayName": "Book2Text",
        # 版本号的唯一来源是 backend/book2text/__init__.py 的 __version__；
        # .app 的 Info.plist 不吃 Python 包，只能在这里手工同步（D-050）。
        "CFBundleShortVersionString": "0.1.0",
        "NSHumanReadableCopyright": "本地工具；未签名，首次打开请右键 →「打开」",
        "LSMinimumSystemVersion": "12.0",
    },
)
