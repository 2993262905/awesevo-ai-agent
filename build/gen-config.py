import json, os, sys, re, datetime

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(PROJ, "build")

EXCLUDE_DIRS = {"data", ".git", "node_modules", "trash", "build"}
EXCLUDE_FILES = {"_smoke.mjs", ".gitignore"}

assets = {}
for dirpath, dirnames, filenames in os.walk(PROJ):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
    for name in filenames:
        if name in EXCLUDE_FILES or name.lower().endswith(".bat"):
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, PROJ).replace("\\", "/")
        assets[rel] = full.replace("\\", "/")

cfg = {
    # 注意：--experimental-sea-config 相对当前工作目录解析这些路径，
    # 所以必须从项目根目录跑（python build/gen-config.py && node --experimental-sea-config build/sea-config.json）
    "main": "build/launcher.cjs",
    "output": "build/sea-prep.blob",
    "disableExperimentalSEAWarning": True,
    "assets": assets,
}
with open(os.path.join(BUILD, "sea-config.json"), "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

total = sum(os.path.getsize(v) for v in assets.values())
print(f"assets: {len(assets)} 个, {total/1024:.1f} KB")

lp = os.path.join(BUILD, "launcher.cjs")
src = open(lp, encoding="utf-8").read()
bid = datetime.datetime.now().strftime("%Y%m%d-%H%M")
src = re.sub(r"const BUILD = '[^']*';", f"const BUILD = '{bid}';", src)
open(lp, "w", encoding="utf-8").write(src)
print("BUILD =", bid)
