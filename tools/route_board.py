#!/usr/bin/env python3
import json
import math
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import pcbnew

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)

BOARD_IN = ROOT / "pcbgolf.kicad_pcb"
PREPARED = BUILD / "pcbgolf-prepared.kicad_pcb"
DSN = BUILD / "pcbgolf.dsn"
SES = BUILD / "pcbgolf.ses"
FINAL = BUILD / "pcbgolf-routed.kicad_pcb"
SUMMARY = BUILD / "route-summary.json"

NETLISTS = [
    BUILD / "pcbgolf.xml",
    BUILD / "pcbgolf_2.xml",
    BUILD / "pcbgolf_3.xml",
    BUILD / "pcbgolf_4.xml",
    BUILD / "pcbgolf_5.xml",
]

def mm(x):
    return pcbnew.FromMM(float(x))

def to_mm(x):
    return pcbnew.ToMM(int(x))

def load_xml_nets():
    # Merge the five stand-alone schematic pages. Named/global nets with the
    # same name are intentionally joined. Auto-generated nets are reference
    # based and therefore remain unique because refs are global across pages.
    nets = defaultdict(set)
    component_refs = set()
    for path in NETLISTS:
        root = ET.parse(path).getroot()
        comps = root.find("components")
        if comps is not None:
            for comp in comps.findall("comp"):
                ref = comp.attrib.get("ref")
                if ref:
                    component_refs.add(ref)
        net_root = root.find("nets")
        if net_root is None:
            continue
        for net in net_root.findall("net"):
            name = net.attrib.get("name", "").strip()
            if not name:
                continue
            for node in net.findall("node"):
                ref = node.attrib.get("ref", "").strip()
                pin = node.attrib.get("pin", "").strip()
                if ref and pin:
                    nets[name].add((ref, pin))
    return nets, component_refs

def footprint_map(board):
    return {fp.GetReference(): fp for fp in board.GetFootprints()}

def clear_existing_nets(board):
    # The challenge starter board is intentionally unrouted and currently has
    # no useful board nets. Clear pad net assignments defensively.
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            pad.SetNetCode(0)

def assign_nets(board, nets):
    fps = footprint_map(board)
    missing_footprints = []
    missing_pads = []
    assigned_nodes = 0
    net_objects = {}

    # Net code 0 is reserved for no-net. Let KiCad allocate explicit codes.
    code = 1
    for name in sorted(nets):
        item = pcbnew.NETINFO_ITEM(board, name, code)
        board.Add(item)
        net_objects[name] = item
        code += 1

    for name, nodes in nets.items():
        net = net_objects[name]
        for ref, pin in sorted(nodes):
            fp = fps.get(ref)
            if fp is None:
                # Power symbols and other schematic-only items can appear in
                # netlists; only report ordinary references as missing.
                if not ref.startswith("#"):
                    missing_footprints.append((ref, pin, name))
                continue
            pads = list(fp.GetPads(pin))
            if not pads:
                missing_pads.append((ref, pin, name))
                continue
            for pad in pads:
                pad.SetNet(net)
            assigned_nodes += 1

    board.BuildListOfNets()
    board.BuildConnectivity()
    return {
        "assigned_nodes": assigned_nodes,
        "missing_footprints": missing_footprints,
        "missing_pads": missing_pads,
        "nets": len(net_objects),
    }

def remove_edge_cuts(board):
    for item in list(board.GetDrawings()):
        if item.GetLayer() == pcbnew.Edge_Cuts:
            board.Delete(item)

def pad_bounds(board):
    xs = []
    ys = []
    # Bounding boxes are used instead of reference/value text so labels cannot
    # accidentally inflate the PCB.
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            bb = pad.GetBoundingBox()
            xs.extend([bb.GetLeft(), bb.GetRight()])
            ys.extend([bb.GetTop(), bb.GetBottom()])
    if not xs:
        raise RuntimeError("no pads found")
    return min(xs), min(ys), max(xs), max(ys)

def add_rect_outline(board, margin_mm=2.5):
    remove_edge_cuts(board)
    x0, y0, x1, y1 = pad_bounds(board)
    m = mm(margin_mm)
    x0 -= m
    y0 -= m
    x1 += m
    y1 += m
    pts = [
        pcbnew.VECTOR2I(x0, y0),
        pcbnew.VECTOR2I(x1, y0),
        pcbnew.VECTOR2I(x1, y1),
        pcbnew.VECTOR2I(x0, y1),
    ]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        edge = pcbnew.PCB_SHAPE(board)
        edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
        edge.SetStart(a)
        edge.SetEnd(b)
        edge.SetLayer(pcbnew.Edge_Cuts)
        edge.SetWidth(mm(0.05))
        board.Add(edge)
    return {
        "x_mm": to_mm(x0),
        "y_mm": to_mm(y0),
        "width_mm": to_mm(x1 - x0),
        "height_mm": to_mm(y1 - y0),
    }

def configure_board(board):
    board.SetCopperLayerCount(2)
    ds = board.GetDesignSettings()
    ds.SetBoardThickness(mm(0.8))
    # Conservative JLC-compatible conventional routing defaults.
    ds.m_TrackMinWidth = mm(0.10)
    ds.m_ViasMinSize = mm(0.45)
    ds.m_ViasMinDrill = mm(0.20)

def stats(board):
    board.BuildConnectivity()
    con = board.GetConnectivity()
    tracks = 0
    vias = 0
    track_length = 0.0
    for t in board.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA):
            vias += 1
        else:
            tracks += 1
            try:
                track_length += to_mm(t.GetLength())
            except Exception:
                pass

    pads = sum(fp.GetPadCount() for fp in board.GetFootprints())
    nets = len(board.GetNetsByName())
    return {
        "footprints": len(list(board.GetFootprints())),
        "pads": int(pads),
        "nets": int(nets),
        "tracks": tracks,
        "vias": vias,
        "track_length_mm": round(track_length, 2),
        "unconnected": int(con.GetUnconnectedCount(False)),
    }

def prepare():
    board = pcbnew.LoadBoard(str(BOARD_IN))
    configure_board(board)
    clear_existing_nets(board)
    nets, component_refs = load_xml_nets()
    assignment = assign_nets(board, nets)
    outline = add_rect_outline(board, 2.5)

    before = stats(board)
    report = {
        "stage": "prepared",
        "outline": outline,
        "assignment": assignment,
        "before_route": before,
        "schematic_component_refs": len(component_refs),
    }

    pcbnew.SaveBoard(str(PREPARED), board)
    if not pcbnew.ExportSpecctraDSN(board, str(DSN)):
        raise RuntimeError("ExportSpecctraDSN failed")
    SUMMARY.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

    # Missing normal footprint/pad mappings mean the physical PCB cannot
    # represent the schematic. Fail rather than silently producing a fake
    # "routed" design.
    if assignment["missing_footprints"] or assignment["missing_pads"]:
        raise SystemExit("netlist-to-footprint mapping incomplete")

def import_route():
    if not SES.exists():
        raise SystemExit(f"missing {SES}")
    board = pcbnew.LoadBoard(str(PREPARED))
    ok = pcbnew.ImportSpecctraSES(board, str(SES))
    if not ok:
        raise RuntimeError("ImportSpecctraSES failed")
    board.BuildConnectivity()
    pcbnew.SaveBoard(str(FINAL), board)

    report = {}
    if SUMMARY.exists():
        report = json.loads(SUMMARY.read_text())
    report["stage"] = "routed"
    report["after_route"] = stats(board)

    # Board area score term uses PCB X/Y for now; final Z comes from the STEP
    # bounding box in the validation stage.
    outline = report["outline"]
    report["board_area_mm2"] = round(outline["width_mm"] * outline["height_mm"], 3)
    SUMMARY.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))

    if report["after_route"]["unconnected"] != 0:
        raise SystemExit(
            f"autorouter left {report['after_route']['unconnected']} unrouted connections"
        )

def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"prepare", "import"}:
        raise SystemExit("usage: route_board.py prepare|import")
    if sys.argv[1] == "prepare":
        prepare()
    else:
        import_route()

if __name__ == "__main__":
    main()
