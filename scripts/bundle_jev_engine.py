#!/usr/bin/env python3
"""把 brew 的 llama.cpp 收成一个**可搬走的** `jev-engine/` 目录（第 5 笔：打包）。

做四件事，顺序不能换：

1. 从 `llama-server` 出发，按 `otool -L` 递归收集依赖（只收 `/opt/homebrew/**` 与 `@rpath/**`；
   `/usr/lib` 与 `/System/Library` 是系统自带，不收）。
2. 每条依赖复制成**安装名**（`@rpath/libllama.0.dylib` → `libllama.0.dylib`），内容取 realpath 的。
3. 把所有引用改成 `@loader_path/<名字>`：这样整个目录搬到 `.app/Contents/Resources/jev-engine/`
   之后仍然找得到邻居，不依赖 brew 的绝对路径。
4. 逐个 **ad-hoc 重签**并验签——改动 Mach-O 会让 Homebrew 原来的签名失效（不重签的话
   `codesign --verify` 直接红，Gatekeeper 报"签名无效"，比"未签名"更难解释）。

用法：

    python3 scripts/bundle_jev_engine.py --out /tmp/jev-engine-bundle
    python3 scripts/bundle_jev_engine.py --out … --binary /opt/homebrew/bin/llama-server

退出码：0 = 目录可用（并能跑 `llama-server --version`）；非 0 = 说清哪一步失败。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

#: 这些前缀属于系统，随 macOS 提供，不能也不该打进去。
SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/", "/System/Volumes/")

#: `@rpath/…` 的候选解析目录（llama.cpp 与它的依赖都在这里）。
RPATH_DIRS = (
    "/opt/homebrew/opt/llama.cpp/lib",
    "/opt/homebrew/opt/ggml/lib",
    "/opt/homebrew/opt/libomp/lib",
    "/opt/homebrew/opt/openssl@4/lib",
    "/opt/homebrew/lib",
)


class BundleError(RuntimeError):
    pass


def run(argv: list[str]) -> str:
    done = subprocess.run(argv, capture_output=True, text=True)
    if done.returncode != 0:
        raise BundleError(f"{' '.join(argv)}\n{done.stdout}{done.stderr}")
    return done.stdout


def deps_of(path: Path) -> list[str]:
    """`otool -L` 的依赖列表（不含第一条自身的 install name）。"""
    out = run(["otool", "-L", str(path)])
    lines = [line.strip() for line in out.splitlines()[1:] if line.strip()]
    return [line.split(" (")[0] for line in lines]


def install_name_of(path: Path) -> str | None:
    out = run(["otool", "-D", str(path)]).strip().splitlines()
    for line in out[1:]:
        text = line.strip()
        if text:
            return text
    return None


def resolve(dep: str, referrer: Path) -> Path:
    """一条依赖 → 真实文件路径。系统依赖返回不了（调用方先过滤）。"""
    if dep.startswith("@rpath/"):
        name = dep[len("@rpath/") :]
        candidates = [referrer.parent / name, *(Path(d) / name for d in RPATH_DIRS)]
        for candidate in candidates:
            if candidate.is_file():
                return Path(os.path.realpath(candidate))
        # Homebrew 的 Cellar 目录名带版本号，扫一遍兜底
        cellar = Path("/opt/homebrew/Cellar")
        if cellar.is_dir():
            for found in cellar.glob(f"*/**/{name}"):
                return Path(os.path.realpath(found))
        raise BundleError(f"解析不了 @rpath 依赖：{dep}（引用方 {referrer}）")
    path = Path(dep)
    if not path.is_file():
        raise BundleError(f"依赖不存在：{dep}（引用方 {referrer}）")
    return Path(os.path.realpath(path))


def is_local(dep: str) -> bool:
    return dep.startswith("@rpath/") or dep.startswith("/opt/homebrew/")


def collect(binary: Path) -> dict[str, Path]:
    """名字 → 真实文件。从 binary 出发递归；只收本机能搬走的那类。"""
    collected: dict[str, Path] = {}
    queue = [binary]
    while queue:
        current = queue.pop()
        for dep in deps_of(current):
            if not is_local(dep):
                continue
            name = Path(dep).name
            if name in collected:
                continue
            real = resolve(dep, current)
            collected[name] = real
            queue.append(real)
    return collected


def rewrite(path: Path, local_names: set[str]) -> None:
    """把 path 里所有本机依赖改成 @loader_path/<名字>；dylib 自己的 id 也改。"""
    for dep in deps_of(path):
        if not is_local(dep):
            continue
        name = Path(dep).name
        if name not in local_names:
            continue
        run(["install_name_tool", "-change", dep, f"@loader_path/{name}", str(path)])
    if path.suffix == ".dylib":
        run(["install_name_tool", "-id", f"@loader_path/{path.name}", str(path)])


def sign(path: Path) -> None:
    run(["codesign", "--force", "--sign", "-", str(path)])


def verify(path: Path) -> None:
    run(["codesign", "--verify", "--strict", str(path)])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 llama.cpp 收成可搬走的 jev-engine/ 目录")
    parser.add_argument("--out", required=True, help="输出目录（会被重建）")
    parser.add_argument("--binary", default="/opt/homebrew/bin/llama-server")
    parser.add_argument("--keep-going", action="store_true", help="验签失败也保留目录（排障用）")
    args = parser.parse_args(argv)

    binary = Path(os.path.realpath(args.binary))
    if not binary.is_file():
        print(f"✗ 找不到引擎：{binary}", file=sys.stderr)
        return 2

    target = Path(args.out)
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)

    collected = collect(binary)
    for name, real in sorted(collected.items()):
        shutil.copy2(real, target / name)
        os.chmod(target / name, 0o755)
    # 主程序最后拷：它也是按"引用改 @loader_path"处理的
    shutil.copy2(binary, target / "llama-server")
    os.chmod(target / "llama-server", 0o755)

    local_names = set(collected) | {"llama-server"}
    for item in [*target.iterdir()]:
        rewrite(item, local_names)

    failures: list[str] = []
    for item in sorted(target.iterdir()):
        try:
            sign(item)
            verify(item)
        except BundleError as exc:
            failures.append(f"{item.name}: {exc}")
    if failures and not args.keep_going:
        print("✗ 签名/验签失败：\n" + "\n".join(failures), file=sys.stderr)
        return 3

    # llama-server 的 `--version` 写在 stderr 上（stdout 为空），所以这里合并两路再取第一行
    probe = subprocess.run(
        [str(target / "llama-server"), "--version"], capture_output=True, text=True
    )
    if probe.returncode != 0:
        print(f"✗ 打包后的引擎起不来（exit={probe.returncode}）", file=sys.stderr)
        print((probe.stdout + probe.stderr)[-800:], file=sys.stderr)
        return 4
    lines = [line.strip() for line in (probe.stdout + probe.stderr).splitlines() if line.strip()]
    version = lines[0] if lines else "（引擎没打印版本号，但退出码 0）"

    total = sum(item.stat().st_size for item in target.iterdir())
    print(f"✔ jev-engine 就绪：{target}")
    print(f"  文件 {len(list(target.iterdir()))} 个 · 合计 {total:,} B（{total / 1e6:.1f} MB）")
    print(f"  {version}")
    if failures:
        print("  ⚠ 有验签失败（按 --keep-going 保留）：\n" + "\n".join(failures), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
