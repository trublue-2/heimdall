"""
PlatformIO post-upload script: Patch-Version in config.h erhöhen.
Läuft NUR nach erfolgreichem Upload — die neue Version landet im nächsten Build.
(Post-Action statt Pre-Action: kein Hochzählen bei fehlgeschlagenem Flash.)
"""
Import("env")
import re, os

def bump_patch(*args, **kwargs):
    config = os.path.join(env.subst("$PROJECT_SRC_DIR"), "config.h")
    with open(config, "r") as f:
        content = f.read()
    m = re.search(r'FW_VERSION "(\d+)\.(\d+)\.(\d+)"', content)
    if not m:
        print("[version] FW_VERSION nicht gefunden — überspringe")
        return
    new_ver = f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}"
    content = re.sub(
        r'FW_VERSION "\d+\.\d+\.\d+"',
        f'FW_VERSION "{new_ver}"',
        content
    )
    with open(config, "w") as f:
        f.write(content)
    print(f"\n→ FW_VERSION bumped to {new_ver}\n")

env.AddPostAction("upload", bump_patch)
