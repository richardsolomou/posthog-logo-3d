"""Build a Bambu Studio project for the X2D from the part STLs, then slice it to prove it prints."""

import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

parts_dir, out_path = (os.path.abspath(p) for p in sys.argv[1:3])
BAMBU = os.environ.get("BAMBU_STUDIO", "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio")
PRESETS = os.environ.get("BAMBU_PRESETS", os.path.expanduser("~/Library/Application Support/BambuStudio/system/BBL"))
PRINTER = "Bambu Lab X2D 0.4 nozzle"
PROCESS = "0.20mm Standard @BBL X2D"
FILAMENT = "Bambu PLA Basic @BBL X2D 0.4 nozzle"
# Part, Bambu PLA Basic color. Filament slots follow this order.
PARTS = [
    ("blue", "#0056B8"),  # Cobalt Blue
    ("orange", "#FF6A13"),  # Orange
    ("yellow", "#FEC600"),  # Sunflower Yellow
    ("head", "#000000"),  # Black
    ("eye", "#FFFFFF"),  # Jade White
]

presets = {}
for f in glob.glob(f"{PRESETS}/*/*.json"):
    try:
        d = json.load(open(f))
    except ValueError:
        continue
    if isinstance(d, dict) and "name" in d:
        presets[(os.path.basename(os.path.dirname(f)), d["name"])] = d


# The CLI crashes on presets that still rely on `inherits`, so resolve the chain up front.
def flatten(kind, name, **overrides):
    d = presets[(kind, name)]
    out = flatten(kind, d["inherits"]) if d.get("inherits") else {}
    out.update(d)
    out.pop("inherits", None)
    out.update(overrides)
    return out


def run(*args):
    r = subprocess.run([BAMBU, *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"Bambu Studio exited {r.returncode}:\n{r.stdout[-2000:]}{r.stderr[-2000:]}")


tmp = tempfile.mkdtemp()


def write(name, data):
    path = os.path.join(tmp, name)
    json.dump(data, open(path, "w"))
    return path


machine = write("machine.json", flatten("machine", PRINTER))
process = write("process.json", flatten("process", PROCESS))
filaments = [write(f"f{i}.json", flatten("filament", FILAMENT, filament_colour=[c])) for i, (_, c) in enumerate(PARTS, 1)]
plate = {
    "plate_name": "Logo parts",
    "need_arrange": True,
    "plate_params": {"print_sequence": "by object"},
    "objects": [
        {"path": f"{parts_dir}/{name}.stl", "count": 1, "filaments": [i], "assemble_index": []}
        for i, (name, _) in enumerate(PARTS, 1)
    ],
}
assemble = write("assemble.json", {"plates": [plate]})
run(
    "--load-settings", f"{machine};{process}",
    "--load-filaments", ";".join(filaments),
    "--load-assemble-list", assemble,
    "--arrange", "1",
    "--outputdir", tmp,
    "--export-3mf", "raw.3mf",
)

# The CLI leaves the X2D's per-nozzle filament maps empty, which fails to slice with
# "No valid nozzle found". Put every filament on the left nozzle.
raw = zipfile.ZipFile(os.path.join(tmp, "raw.3mf"))
config = json.loads(raw.read("Metadata/project_settings.config"))
n = len(config["filament_colour"])
config.update(
    filament_map=["1"] * n,
    filament_nozzle_map=["0"] * n,
    filament_volume_map=["0"] * n,
    extruder_nozzle_stats=["Standard#1", "Standard#1"],
    extruder_nozzle_count=["1", "1"],
    extruder_nozzle_volume_type=["Standard", "Standard"],
)
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out:
    for item in raw.infolist():
        data = raw.read(item.filename)
        if item.filename == "Metadata/project_settings.config":
            data = json.dumps(config, indent=4).encode()
        out.writestr(item, data)

sliced = os.path.join(tmp, "sliced")
os.makedirs(sliced)
run("--slice", "0", "--outputdir", sliced, "--export-3mf", "out.3mf", out_path)
gcode = open(os.path.join(sliced, "plate_1.gcode")).read()
changes = len(re.findall(r"^M620 S\d+A", gcode, re.M))
if changes != len(PARTS) - 1:
    sys.exit(f"expected {len(PARTS) - 1} filament changes, sliced G-code has {changes}")
time = re.search(r"^; model printing time: (.+?);", gcode, re.M)
print(f"{out_path}: sliced, {changes} filament changes, {time.group(1) if time else 'unknown time'}")
