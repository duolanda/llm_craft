from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import bpy
from mathutils import Vector


CLIENT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = CLIENT_ROOT / "public" / "assets" / "models" / "battlefield"
TEXTURE_DIR = CLIENT_ROOT / "public" / "assets" / "textures" / "battlefield"
SOURCE_DIR = CLIENT_ROOT / "assets" / "source" / "quaternius"
HUMAN_SOURCE = SOURCE_DIR / "AnimatedMen-MaleLongSleeve.blend"
TANK_SOURCE = SOURCE_DIR / "AnimatedTanks-Tank4.blend"
GEOMETRY_SPEC_PATH = CLIENT_ROOT.parent / "shared" / "src" / "entity-geometry.json"
ENTITY_GEOMETRY = json.loads(GEOMETRY_SPEC_PATH.read_text(encoding="utf-8"))
UNIT_BODY_GEOMETRY = ENTITY_GEOMETRY["unitBodies"]
BUILDING_BODY_GEOMETRY = ENTITY_GEOMETRY["buildingBodies"]
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.materials):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def load_image(path: Path, *, non_color: bool = False) -> bpy.types.Image:
    image = bpy.data.images.load(str(path), check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def textured_material(
    name: str,
    texture_name: str,
    *,
    metallic: float = 0.0,
    roughness: float = 0.6,
    tint: tuple[float, float, float, float] = (1, 1, 1, 1),
) -> bpy.types.Material:
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = tint
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    albedo = nodes.new("ShaderNodeTexImage")
    albedo.image = load_image(TEXTURE_DIR / f"{texture_name}_albedo.png")
    albedo.interpolation = "Linear"
    links.new(albedo.outputs["Color"], shader.inputs["Base Color"])

    roughness_node = nodes.new("ShaderNodeTexImage")
    roughness_node.image = load_image(TEXTURE_DIR / f"{texture_name}_roughness.png", non_color=True)
    roughness_node.interpolation = "Linear"
    links.new(roughness_node.outputs["Color"], shader.inputs["Roughness"])

    normal_texture = nodes.new("ShaderNodeTexImage")
    normal_texture.image = load_image(TEXTURE_DIR / f"{texture_name}_normal.png", non_color=True)
    normal_texture.interpolation = "Linear"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.72
    links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    return material


def flat_material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float = 0.0,
    roughness: float = 0.55,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    material.diffuse_color = color
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emission:
        shader.inputs["Emission Color"].default_value = emission
        shader.inputs["Emission Strength"].default_value = emission_strength
    return material


def build_materials() -> dict[str, bpy.types.Material]:
    return {
        "team": textured_material("team_primary", "team_armor", metallic=0.28, roughness=0.48),
        "accent": textured_material("team_accent", "team_armor", metallic=0.2, roughness=0.42),
        "fabric": textured_material("fabric_dark", "fabric", roughness=0.88),
        "metal": textured_material("armor_dark", "dark_metal", metallic=0.66, roughness=0.36),
        "industrial": textured_material("factory_metal", "industrial", metallic=0.48, roughness=0.5),
        "concrete": textured_material("concrete_dark", "concrete", roughness=0.9),
        "rubber": flat_material("rubber", (0.018, 0.022, 0.021, 1), roughness=0.92),
        "skin": flat_material("skin", (0.42, 0.23, 0.14, 1), roughness=0.76),
        "glass": flat_material(
            "glass_emissive",
            (0.05, 0.36, 0.5, 1),
            metallic=0.12,
            roughness=0.18,
            emission=(0.08, 0.68, 1, 1),
            emission_strength=1.8,
        ),
        "warning": flat_material(
            "warning_emissive",
            (0.95, 0.28, 0.035, 1),
            roughness=0.38,
            emission=(1, 0.12, 0.015, 1),
            emission_strength=1.5,
        ),
        "worker": flat_material("worker_safety", (0.82, 0.52, 0.055, 1), roughness=0.64),
        "gunner": flat_material("gunner_armor", (0.105, 0.13, 0.12, 1), metallic=0.32, roughness=0.46),
        "rocket": flat_material("rocket_armor", (0.34, 0.31, 0.2, 1), metallic=0.12, roughness=0.68),
        "gold": flat_material(
            "resource_gold",
            (1, 0.54, 0.06, 1),
            roughness=0.28,
            emission=(1, 0.25, 0.02, 1),
            emission_strength=0.9,
        ),
        "rock": textured_material("rock_gray", "concrete", roughness=0.96, tint=(0.48, 0.52, 0.49, 1)),
    }


def finish_mesh(
    obj: bpy.types.Object,
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    smooth: bool = False,
    unwrap: bool = True,
) -> bpy.types.Object:
    obj.data.materials.append(material)
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if bevel > 0:
        modifier = obj.modifiers.new("edge_bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    if unwrap:
        smart_unwrap(obj)
    return obj


def smart_unwrap(obj: bpy.types.Object) -> None:
    if obj.type != "MESH" or not obj.data.polygons:
        return
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.018)
    bpy.ops.object.mode_set(mode="OBJECT")


def cube(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    return finish_mesh(obj, material, bevel=bevel)


def cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material: bpy.types.Material,
    *,
    vertices: int = 20,
    rotation: tuple[float, float, float] = (0, 0, 0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation
    )
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, material, bevel=bevel, smooth=True)


def cylinder_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    material: bpy.types.Material,
    *,
    vertices: int = 16,
    bevel: float = 0.0,
) -> bpy.types.Object:
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    midpoint = (start_vector + end_vector) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=direction.length, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction.normalized())
    return finish_mesh(obj, material, bevel=bevel, smooth=True)


def cone(
    name: str,
    location: tuple[float, float, float],
    radius1: float,
    radius2: float,
    depth: float,
    material: bpy.types.Material,
    *,
    vertices: int = 20,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius1,
        radius2=radius2,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, material, bevel=0.012, smooth=True)


def sphere(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    segments: int = 24,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=12, radius=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material, smooth=True)


def wedge(
    name: str,
    location: tuple[float, float, float],
    width: float,
    depth: float,
    height: float,
    top_scale: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    bottom_x = width / 2
    bottom_y = depth / 2
    top_x = bottom_x * top_scale
    top_y = bottom_y * top_scale
    vertices = [
        (-bottom_x, -bottom_y, 0), (bottom_x, -bottom_y, 0),
        (bottom_x, bottom_y, 0), (-bottom_x, bottom_y, 0),
        (-top_x, -top_y, height), (top_x, -top_y, height),
        (top_x, top_y, height), (-top_x, top_y, height),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7),
    ]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    return finish_mesh(obj, material, bevel=min(width, depth, height) * 0.06)


def append_objects(path: Path) -> list[bpy.types.Object]:
    with bpy.data.libraries.load(str(path), link=False) as (source, target):
        target.objects = source.objects
    objects = [obj for obj in target.objects if obj is not None]
    for obj in objects:
        if obj.name not in bpy.context.scene.objects:
            bpy.context.collection.objects.link(obj)
    return objects


def bake_deformed_meshes(objects: list[bpy.types.Object], frame: int) -> list[bpy.types.Object]:
    bpy.context.scene.frame_set(frame)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked: list[bpy.types.Object] = []
    for source in [obj for obj in objects if obj.type == "MESH"]:
        evaluated = source.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        obj = bpy.data.objects.new(f"{source.name}_baked", mesh)
        obj.matrix_world = source.matrix_world.copy()
        bpy.context.collection.objects.link(obj)
        baked.append(obj)
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    return baked


def scale_and_ground(objects: list[bpy.types.Object], scale: float) -> None:
    for obj in objects:
        obj.location *= scale
        obj.scale = (scale, scale, scale)
        activate(obj)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.view_layer.update()
    minimum_z = min(
        (obj.matrix_world @ Vector(corner)).z
        for obj in objects
        if obj.type == "MESH"
        for corner in obj.bound_box
    )
    for obj in objects:
        obj.location.z -= minimum_z


def horizontal_bounds(objects: list[bpy.types.Object]) -> tuple[float, float]:
    points = [
        obj.matrix_world @ Vector(corner)
        for obj in objects
        if obj.type == "MESH"
        for corner in obj.bound_box
    ]
    if not points:
        raise RuntimeError("Cannot measure an empty model body")
    return (
        max(point.x for point in points) - min(point.x for point in points),
        max(point.y for point in points) - min(point.y for point in points),
    )


def apply_uniform_scale(objects: list[bpy.types.Object], scale: float) -> None:
    for obj in objects:
        obj.location *= scale
        obj.scale = tuple(component * scale for component in obj.scale)
        activate(obj)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.view_layer.update()


def normalize_horizontal_footprint(
    label: str,
    objects: list[bpy.types.Object],
    body_objects: list[bpy.types.Object],
    target_length: float,
    target_width: float,
) -> None:
    source_length, source_width = horizontal_bounds(body_objects)
    scale = min(target_length / source_length, target_width / source_width)
    apply_uniform_scale(objects, scale)
    actual_length, actual_width = horizontal_bounds(body_objects)
    tolerance = 0.015
    if actual_length > target_length + tolerance or actual_width > target_width + tolerance:
        raise RuntimeError(
            f"{label} body exceeds its canonical footprint: "
            f"{actual_length:.3f}x{actual_width:.3f} > {target_length:.3f}x{target_width:.3f}"
        )
    if actual_length / target_length < 0.82 or actual_width / target_width < 0.82:
        raise RuntimeError(
            f"{label} body under-fills its canonical footprint: "
            f"{actual_length:.3f}x{actual_width:.3f} vs {target_length:.3f}x{target_width:.3f}"
        )
    print(
        f"GEOMETRY {label}: body={actual_length:.3f}x{actual_width:.3f} cells "
        f"target={target_length:.3f}x{target_width:.3f} scale={scale:.4f}"
    )


def ground_scene_meshes() -> None:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        return
    bpy.context.view_layer.update()
    minimum_z = min((obj.matrix_world @ Vector(corner)).z for obj in meshes for corner in obj.bound_box)
    for obj in meshes:
        obj.location.z -= minimum_z


def replace_human_materials(obj: bpy.types.Object, materials: dict[str, bpy.types.Material]) -> None:
    replacement = {
        "Eyes": materials["glass"],
        "Hair": materials["metal"],
        "Pants": materials["fabric"],
        "Shirt": materials["fabric"],
        "Shoes": materials["rubber"],
        "Skin": materials["skin"],
        "Socks": materials["fabric"],
    }
    for slot in obj.material_slots:
        slot.material = replacement.get(slot.material.name if slot.material else "", materials["fabric"])
    smart_unwrap(obj)


def infantry_base(materials: dict[str, bpy.types.Material], variant: str) -> list[bpy.types.Object]:
    source = append_objects(HUMAN_SOURCE)
    baked = bake_deformed_meshes(source, 18)
    scale_and_ground(baked, 0.285)
    for obj in baked:
        replace_human_materials(obj, materials)

    class_material = (
        materials["worker"] if variant == "worker"
        else materials["gunner"] if variant == "rifleman"
        else materials["rocket"] if variant == "rocket_soldier"
        else materials["team"]
    )
    helmet_material = materials["worker"] if variant == "worker" else materials["team"]
    wedge("combat_vest", (0, -0.065, 0.84), 0.44, 0.24, 0.46, 0.82, class_material)
    cube("chest_rig", (0, -0.22, 0.85), (0.34, 0.08, 0.22), materials["accent"], bevel=0.025)
    for x in (-0.13, 0, 0.13):
        cube(f"magazine_pouch_{x}", (x, -0.275, 0.78), (0.095, 0.055, 0.18), materials["fabric"], bevel=0.015)
    cube("battle_belt", (0, -0.01, 0.6), (0.43, 0.2, 0.085), materials["metal"], bevel=0.018)
    cube("radio_pack", (0.2, 0.13, 0.86), (0.18, 0.13, 0.34), materials["metal"], bevel=0.025)
    cylinder("radio_antenna", (0.25, 0.16, 1.17), 0.012, 0.46, materials["metal"], vertices=8)
    sphere("combat_helmet", (0, 0, 1.31), (0.21, 0.2, 0.14), helmet_material)
    cube("helmet_rail", (0, -0.19, 1.31), (0.28, 0.035, 0.055), materials["accent"], bevel=0.012)
    cube("visor", (0, -0.215, 1.25), (0.24, 0.028, 0.065), materials["glass"], bevel=0.012)
    for side in (-1, 1):
        wedge(f"shoulder_guard_{side}", (side * 0.29, -0.02, 0.99), 0.18, 0.2, 0.17, 0.76, materials["team"])
        cube(f"knee_guard_{side}", (side * 0.105, -0.12, 0.34), (0.15, 0.08, 0.16), materials["metal"], bevel=0.025)
    return baked


def add_rifle(materials: dict[str, bpy.types.Material], *, marksman: bool = False) -> None:
    length = 0.88 if marksman else 0.72
    cube("rifle_receiver", (0.18, -0.29, 0.84), (0.16, 0.38, 0.12), materials["metal"], bevel=0.018)
    wedge("rifle_stock", (0.18, -0.015, 0.78), 0.18, 0.3, 0.12, 0.65, materials["fabric"])
    cylinder(
        "rifle_barrel",
        (0.18, -0.48 - length * 0.28, 0.86),
        0.026,
        length,
        materials["metal"],
        vertices=12,
        rotation=(math.pi / 2, 0, 0),
    )
    cylinder(
        "rifle_muzzle",
        (0.18, -0.84 if marksman else -0.74, 0.86),
        0.043,
        0.1,
        materials["metal"],
        vertices=12,
        rotation=(math.pi / 2, 0, 0),
    )
    cube("rifle_grip", (0.18, -0.34, 0.72), (0.09, 0.1, 0.2), materials["fabric"], bevel=0.015, rotation=(-0.2, 0, 0))
    cube("rifle_magazine", (0.18, -0.42, 0.69), (0.11, 0.12, 0.2), materials["accent"], bevel=0.015, rotation=(-0.18, 0, 0))
    if marksman:
        cylinder("scope", (0.18, -0.35, 0.97), 0.045, 0.28, materials["glass"], vertices=16, rotation=(math.pi / 2, 0, 0))


def add_machine_gun(materials: dict[str, bpy.types.Material]) -> None:
    cube("mg_receiver", (0.2, -0.33, 0.88), (0.24, 0.5, 0.18), materials["metal"], bevel=0.025)
    wedge("mg_stock", (0.2, 0.015, 0.8), 0.24, 0.38, 0.17, 0.7, materials["gunner"])
    cylinder("mg_heavy_barrel", (0.2, -0.88, 0.9), 0.045, 1.12, materials["metal"], vertices=16, rotation=(math.pi / 2, 0, 0))
    cylinder("mg_muzzle_brake", (0.2, -1.45, 0.9), 0.075, 0.18, materials["metal"], vertices=14, rotation=(math.pi / 2, 0, 0))
    cube("mg_ammo_box", (0.34, -0.3, 0.67), (0.24, 0.25, 0.3), materials["gunner"], bevel=0.025)
    cube("mg_carry_handle", (0.2, -0.34, 1.02), (0.16, 0.2, 0.055), materials["accent"], bevel=0.012)
    cube("mg_ammo_pack", (0, 0.18, 0.9), (0.5, 0.22, 0.58), materials["team"], bevel=0.045)
    cube("mg_pack_center", (0, 0.305, 0.9), (0.25, 0.035, 0.38), materials["gunner"], bevel=0.025)
    for side in (-1, 1):
        cylinder(
            f"mg_bipod_{side}",
            (0.2 + side * 0.11, -1.05, 0.68),
            0.018,
            0.48,
            materials["metal"],
            vertices=8,
            rotation=(0.45, side * 0.2, 0),
        )
        wedge(f"gunner_heavy_pauldron_{side}", (side * 0.34, -0.01, 1.0), 0.26, 0.28, 0.24, 0.72, materials["team"])


def build_infantry(variant: str) -> None:
    materials = build_materials()
    infantry_base(materials, variant)
    if variant == "worker":
        cube("engineering_pack", (-0.2, 0.18, 0.83), (0.42, 0.2, 0.52), materials["worker"], bevel=0.035)
        cube("engineering_team_panel", (-0.2, 0.295, 0.83), (0.28, 0.035, 0.34), materials["team"], bevel=0.02)
        cylinder("welder", (0.27, -0.22, 0.7), 0.045, 0.48, materials["metal"], vertices=14, rotation=(0.65, 0.12, -0.45))
        cube("helmet_lamp", (0, -0.215, 1.39), (0.13, 0.04, 0.055), materials["warning"], bevel=0.01)
    elif variant == "rocket_soldier":
        cylinder("launcher_tube", (0.31, -0.08, 1.18), 0.14, 1.32, materials["rocket"], vertices=22, rotation=(math.pi / 2, 0, 0))
        cylinder("launcher_team_band", (0.31, -0.18, 1.18), 0.155, 0.22, materials["team"], vertices=22, rotation=(math.pi / 2, 0, 0))
        cone("rocket_warhead", (0.31, -0.79, 1.18), 0.14, 0.035, 0.28, materials["accent"], rotation=(math.pi / 2, 0, 0))
        cone("launcher_backblast", (0.31, 0.64, 1.18), 0.21, 0.14, 0.28, materials["warning"], rotation=(math.pi / 2, 0, 0))
        cube("launcher_sight", (0.31, -0.25, 1.37), (0.18, 0.25, 0.13), materials["glass"], bevel=0.018)
        for x in (-0.15, 0.15):
            cylinder(f"reserve_rocket_{x}", (x, 0.2, 0.88), 0.09, 0.9, materials["rocket"], vertices=16)
            cylinder(f"reserve_rocket_team_cap_{x}", (x, 0.2, 0.46), 0.1, 0.12, materials["team"], vertices=16)
            cone(f"reserve_warhead_{x}", (x, 0.2, 1.37), 0.09, 0.025, 0.18, materials["accent"])
        wedge("rocket_shoulder_pad", (0.3, 0.0, 1.03), 0.34, 0.32, 0.24, 0.72, materials["team"])
    elif variant == "rifleman":
        add_machine_gun(materials)
    else:
        add_rifle(materials)


def build_tank() -> None:
    materials = build_materials()
    source = append_objects(TANK_SOURCE)
    baked = bake_deformed_meshes(source, 8)
    scale_and_ground(baked, 0.155)
    replacement = {
        "Main": materials["team"],
        "Main_Dark": materials["industrial"],
        "Main_Details": materials["accent"],
        "Main_Light": materials["industrial"],
        "Wheels": materials["rubber"],
    }
    for obj in baked:
        for slot in obj.material_slots:
            slot.material = replacement.get(slot.material.name if slot.material else "", materials["metal"])
        smart_unwrap(obj)
    cube("commander_optics", (0.34, -0.08, 0.88), (0.22, 0.18, 0.16), materials["glass"], bevel=0.025)
    cylinder("commander_antenna", (0.52, 0.08, 1.15), 0.018, 0.62, materials["metal"], vertices=8)
    for x in (-0.72, 0.72):
        for y in (-0.38, 0.08, 0.52):
            cube(f"reactive_armor_{x}_{y}", (x, y, 0.56), (0.18, 0.32, 0.19), materials["team"], bevel=0.022)
    cube("rear_engine_grille", (0, 0.72, 0.52), (0.72, 0.06, 0.34), materials["industrial"], bevel=0.018)

    # Quaternius Tank 4 faces local -X and its turret ring is offset from the
    # source origin. Rebase every tank part to the ring so split turret assets
    # rotate in place instead of orbiting around the vehicle origin.
    turret_ring_x = 1.467 * 0.155
    turret_ring_y = 0.067 * 0.155
    for obj in [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]:
        obj.location.x -= turret_ring_x
        obj.location.y -= turret_ring_y


def add_track_chassis(
    materials: dict[str, bpy.types.Material],
    asset_name: str,
    *,
    length: float,
    width: float,
    hull_height: float,
    track_width: float,
) -> None:
    cube(
        f"{asset_name}_body_lower_hull",
        (0.08, 0, 0.42),
        (length * 0.88, width - track_width * 1.35, hull_height),
        materials["industrial"],
        bevel=0.09,
    )
    wedge(
        f"{asset_name}_body_upper_hull",
        (-length * 0.08, 0, 0.58),
        length * 0.72,
        width - track_width * 1.75,
        hull_height * 0.88,
        0.72,
        materials["team"],
    )
    for side in (-1, 1):
        y = side * (width * 0.5 - track_width * 0.5)
        cube(
            f"{asset_name}_body_track_{side}",
            (0.08, y, 0.38),
            (length, track_width, 0.58),
            materials["rubber"],
            bevel=0.13,
        )
        cube(
            f"{asset_name}_body_track_guard_{side}",
            (-0.02, y, 0.72),
            (length * 0.86, track_width * 1.08, 0.13),
            materials["accent"],
            bevel=0.035,
        )
        for x in (-length * 0.31, -length * 0.1, length * 0.12, length * 0.33):
            cylinder(
                f"{asset_name}_body_roadwheel_{side}_{x}",
                (x, y + side * track_width * 0.51, 0.37),
                0.23,
                track_width * 0.08,
                materials["industrial"],
                vertices=12,
                rotation=(math.pi / 2, 0, 0),
            )


def build_scout_car() -> None:
    materials = build_materials()
    asset_name = "scout_car"
    # A low six-wheeled wedge reads immediately differently from every tracked vehicle.
    wedge(f"{asset_name}_body_armored_hull", (0.05, 0, 0.38), 2.75, 1.42, 0.62, 0.72, materials["team"])
    wedge(f"{asset_name}_body_sloped_nose", (-1.22, 0, 0.43), 0.72, 1.25, 0.5, 0.34, materials["accent"])
    cube(f"{asset_name}_body_rear_deck", (0.93, 0, 0.52), (0.62, 1.22, 0.38), materials["metal"], bevel=0.065)
    for side in (-1, 1):
        y = side * 0.77
        for index, x in enumerate((-0.88, 0.0, 0.88)):
            cylinder(
                f"{asset_name}_body_wheel_{side}_{index}",
                (x, y, 0.32),
                0.34,
                0.24,
                materials["rubber"],
                vertices=16,
                rotation=(math.pi / 2, 0, 0),
                bevel=0.025,
            )
            cylinder(
                f"{asset_name}_body_hub_{side}_{index}",
                (x, y + side * 0.13, 0.32),
                0.14,
                0.035,
                materials["accent"],
                vertices=12,
                rotation=(math.pi / 2, 0, 0),
            )
    cube(f"{asset_name}_body_windscreen", (-0.42, 0, 0.83), (0.08, 0.82, 0.28), materials["glass"], bevel=0.025)
    for side in (-1, 1):
        cube(f"{asset_name}_body_headlight_{side}", (-1.49, side * 0.4, 0.43), (0.08, 0.2, 0.12), materials["warning"], bevel=0.018)
    cylinder(f"{asset_name}_turret_ring", (-0.05, 0, 0.86), 0.38, 0.16, materials["accent"], vertices=16)
    wedge(f"{asset_name}_turret_cupola", (-0.05, 0, 0.94), 0.72, 0.68, 0.35, 0.72, materials["team"])
    cylinder_between(f"{asset_name}_turret_autocannon", (-0.24, 0, 1.11), (-1.2, 0, 1.11), 0.055, materials["industrial"], vertices=12)
    cube(f"{asset_name}_turret_sensor", (-0.14, -0.27, 1.18), (0.25, 0.18, 0.2), materials["glass"], bevel=0.025)
    for side in (-1, 1):
        cylinder(f"{asset_name}_turret_antenna_{side}", (0.12, side * 0.22, 1.45), 0.012, 0.72, materials["industrial"], vertices=8)


def build_heavy_tank() -> None:
    materials = build_materials()
    asset_name = "heavy_tank"
    add_track_chassis(materials, asset_name, length=3.55, width=2.38, hull_height=0.68, track_width=0.5)
    wedge(f"{asset_name}_body_glacis", (-1.0, 0, 0.78), 1.45, 1.58, 0.62, 0.62, materials["team"])
    cube(f"{asset_name}_body_engine_deck", (1.05, 0, 0.86), (1.05, 1.55, 0.32), materials["industrial"], bevel=0.065)
    for side in (-1, 1):
        for x in (-0.85, -0.28, 0.3, 0.88):
            cube(f"{asset_name}_body_reactive_block_{side}_{x}", (x, side * 0.88, 0.94), (0.45, 0.19, 0.28), materials["accent"], bevel=0.035)
    cylinder(f"{asset_name}_turret_ring", (-0.12, 0, 1.06), 0.74, 0.18, materials["accent"], vertices=20)
    wedge(f"{asset_name}_turret_heavy_cast", (-0.18, 0, 1.12), 1.62, 1.52, 0.78, 0.68, materials["team"])
    cube(f"{asset_name}_turret_mantlet", (-0.98, 0, 1.43), (0.32, 0.82, 0.48), materials["accent"], bevel=0.08)
    cylinder_between(f"{asset_name}_turret_main_gun", (-1.08, 0, 1.44), (-3.45, 0, 1.44), 0.12, materials["industrial"], vertices=18, bevel=0.015)
    cylinder_between(f"{asset_name}_turret_muzzle_brake", (-3.24, 0, 1.44), (-3.72, 0, 1.44), 0.18, materials["accent"], vertices=16)
    cube(f"{asset_name}_turret_rear_bustle", (0.7, 0, 1.42), (0.72, 1.28, 0.54), materials["team"], bevel=0.09)
    for side in (-1, 1):
        wedge(f"{asset_name}_turret_armor_cheek_{side}", (-0.46, side * 0.7, 1.39), 0.88, 0.2, 0.52, 0.62, materials["accent"])
    cylinder(f"{asset_name}_turret_commander_hatch", (0.18, -0.42, 1.95), 0.28, 0.18, materials["accent"], vertices=16)
    cube(f"{asset_name}_turret_optics", (-0.6, 0.48, 1.76), (0.32, 0.24, 0.25), materials["glass"], bevel=0.035)
    for side in (-1, 1):
        cylinder(f"{asset_name}_turret_antenna_{side}", (0.5, side * 0.43, 2.18), 0.018, 0.85, materials["industrial"], vertices=8)


def build_artillery() -> None:
    materials = build_materials()
    asset_name = "artillery"
    add_track_chassis(materials, asset_name, length=3.25, width=1.82, hull_height=0.46, track_width=0.36)
    cube(f"{asset_name}_body_front_cabin", (-0.95, 0, 0.96), (0.82, 1.05, 0.62), materials["team"], bevel=0.075)
    cube(f"{asset_name}_body_front_glass", (-1.39, 0, 1.02), (0.06, 0.62, 0.23), materials["glass"], bevel=0.02)
    # Rear stabilizers and a very long elevated barrel create an unmistakable artillery silhouette.
    for side in (-1, 1):
        cylinder_between(f"{asset_name}_body_rear_spade_arm_{side}", (1.05, side * 0.58, 0.55), (1.92, side * 0.9, 0.18), 0.07, materials["industrial"], vertices=10)
        cube(f"{asset_name}_body_rear_spade_{side}", (2.02, side * 0.98, 0.16), (0.42, 0.5, 0.18), materials["warning"], bevel=0.035)
    cylinder(f"{asset_name}_turret_ring", (0.32, 0, 0.85), 0.56, 0.16, materials["accent"], vertices=18)
    wedge(f"{asset_name}_turret_breech", (0.22, 0, 0.92), 1.05, 1.08, 0.62, 0.68, materials["team"])
    cube(f"{asset_name}_turret_counterweight", (0.76, 0, 1.16), (0.62, 0.92, 0.58), materials["accent"], bevel=0.07)
    for side in (-1, 1):
        wedge(f"{asset_name}_turret_gun_shield_{side}", (0.0, side * 0.47, 1.28), 1.24, 0.12, 0.92, 0.7, materials["team"])
    cylinder_between(f"{asset_name}_turret_long_barrel", (-0.15, 0, 1.2), (-4.25, 0, 2.42), 0.105, materials["industrial"], vertices=18, bevel=0.012)
    cylinder_between(f"{asset_name}_turret_muzzle", (-3.98, 0, 2.34), (-4.52, 0, 2.5), 0.17, materials["accent"], vertices=16)
    for side in (-1, 1):
        cylinder_between(f"{asset_name}_turret_recoil_rail_{side}", (0.25, side * 0.25, 1.02), (-1.35, side * 0.25, 1.5), 0.055, materials["industrial"], vertices=10)
    cube(f"{asset_name}_turret_rangefinder", (-0.15, -0.48, 1.42), (0.52, 0.22, 0.26), materials["glass"], bevel=0.035)


def build_machine_gun_turret() -> None:
    materials = build_materials()
    cylinder("mg_turret_foundation", (0, 0, 0.18), 1.28, 0.36, materials["concrete"], vertices=12, bevel=0.035)
    cylinder("mg_turret_team_ring", (0, 0, 0.42), 1.02, 0.18, materials["team"], vertices=12)
    wedge("mg_turret_pedestal", (0, 0, 0.48), 0.82, 0.82, 0.82, 0.62, materials["industrial"])
    cube("mg_turret_shield", (-0.08, 0, 1.32), (0.32, 1.12, 0.62), materials["team"], bevel=0.065)
    for side in (-1, 1):
        cylinder_between(f"mg_turret_barrel_{side}", (-0.18, side * 0.24, 1.38), (-1.42, side * 0.24, 1.38), 0.045, materials["metal"], vertices=12)
        cylinder_between(f"mg_turret_muzzle_{side}", (-1.32, side * 0.24, 1.38), (-1.58, side * 0.24, 1.38), 0.07, materials["accent"], vertices=12)
    cube("mg_turret_ammo_box", (0.2, 0, 1.24), (0.42, 0.74, 0.42), materials["warning"], bevel=0.045)
    cube("mg_turret_optic", (-0.34, 0, 1.72), (0.24, 0.28, 0.2), materials["glass"], bevel=0.025)


def build_anti_tank_turret() -> None:
    materials = build_materials()
    cylinder("at_turret_foundation", (0, 0, 0.22), 1.62, 0.44, materials["concrete"], vertices=12, bevel=0.05)
    wedge("at_turret_bunker", (0, 0, 0.38), 2.5, 2.2, 0.86, 0.72, materials["team"])
    for side in (-1, 1):
        cube(f"at_turret_side_armor_{side}", (0.05, side * 1.02, 0.84), (1.65, 0.2, 0.54), materials["accent"], bevel=0.055)
    cylinder("at_turret_traverse_ring", (0, 0, 1.12), 0.78, 0.22, materials["metal"], vertices=18)
    wedge("at_turret_gunhouse", (-0.12, 0, 1.2), 1.35, 1.48, 0.74, 0.68, materials["industrial"])
    cube("at_turret_mantlet", (-0.84, 0, 1.54), (0.32, 0.82, 0.52), materials["team"], bevel=0.07)
    cylinder_between("at_turret_cannon", (-0.95, 0, 1.54), (-3.1, 0, 1.54), 0.12, materials["metal"], vertices=18)
    cylinder_between("at_turret_muzzle_brake", (-2.88, 0, 1.54), (-3.36, 0, 1.54), 0.19, materials["accent"], vertices=16)
    cube("at_turret_optic", (-0.45, -0.58, 1.88), (0.34, 0.26, 0.25), materials["glass"], bevel=0.035)
    for side in (-1, 1):
        cube(f"at_turret_warning_panel_{side}", (0.65, side * 0.72, 0.78), (0.48, 0.07, 0.28), materials["warning"], bevel=0.025)


def build_tech_center() -> None:
    materials = build_materials()
    cylinder("tech_foundation", (0, 0, 0.22), 2.95, 0.44, materials["concrete"], vertices=12, bevel=0.06)
    cylinder("tech_team_plinth", (0, 0, 0.54), 2.55, 0.28, materials["team"], vertices=12)
    # Three asymmetric research wings frame a bright central reactor and a tall sensor crown.
    for index, angle in enumerate((0, math.tau / 3, math.tau * 2 / 3)):
        x = math.cos(angle) * 1.55
        y = math.sin(angle) * 1.55
        cube(f"tech_research_wing_{index}", (x, y, 1.15), (1.5, 1.05, 1.35), materials["industrial"], bevel=0.12, rotation=(0, 0, angle))
        cube(f"tech_team_fin_{index}", (x * 1.15, y * 1.15, 1.42), (0.22, 0.8, 1.58), materials["accent"], bevel=0.055, rotation=(0, 0, angle))
        cube(f"tech_lab_window_{index}", (x * 0.72, y * 0.72, 1.35), (0.72, 0.12, 0.38), materials["glass"], bevel=0.035, rotation=(0, 0, angle + math.pi / 2))
    cylinder("tech_reactor_core", (0, 0, 1.68), 0.78, 2.42, materials["glass"], vertices=20)
    for z, radius in ((0.78, 1.08), (1.62, 1.0), (2.48, 0.88)):
        cylinder(f"tech_reactor_ring_{z}", (0, 0, z), radius, 0.16, materials["team"], vertices=20)
    cylinder("tech_sensor_mast", (0, 0, 3.62), 0.12, 2.5, materials["metal"], vertices=12)
    sphere("tech_sensor_dish", (0, 0, 4.22), (1.42, 0.24, 0.86), materials["accent"], segments=28)
    cylinder("tech_sensor_hub", (-0.18, 0, 4.22), 0.2, 0.62, materials["glass"], vertices=16, rotation=(0, math.pi / 2, 0))
    for side in (-1, 1):
        cylinder("tech_aux_antenna_" + str(side), (side * 1.42, 0.55, 3.28), 0.045, 2.55, materials["metal"], vertices=8)
        sphere("tech_aux_beacon_" + str(side), (side * 1.42, 0.55, 4.6), (0.14, 0.14, 0.14), materials["warning"], segments=16)


def add_hazard_lights(materials: dict[str, bpy.types.Material], width: float, y: float, z: float) -> None:
    for x in (-width, width):
        cube(f"hazard_light_{x}_{z}", (x, y, z), (0.18, 0.08, 0.12), materials["warning"], bevel=0.018)


def build_hq() -> None:
    materials = build_materials()
    cube("hq_foundation", (0, 0, 0.22), (7.8, 7.0, 0.44), materials["concrete"], bevel=0.1)
    cube("hq_command_keep", (0, 0.55, 1.45), (4.2, 4.0, 2.5), materials["industrial"], bevel=0.16)
    wedge("hq_upper_command", (0, 0.45, 2.55), 3.35, 3.0, 2.45, 0.72, materials["team"])
    cube("hq_bridge_glass", (0, -1.12, 3.55), (2.65, 0.12, 0.62), materials["glass"], bevel=0.035)
    for x in (-0.98, -0.49, 0, 0.49, 0.98):
        cube(f"hq_bridge_divider_{x}", (x, -1.21, 3.55), (0.055, 0.06, 0.6), materials["metal"], bevel=0.008)
    for side in (-1, 1):
        cube(f"hq_wing_{side}", (side * 2.65, 0.45, 1.0), (1.55, 4.9, 1.55), materials["industrial"], bevel=0.14)
        wedge(f"hq_bastion_{side}", (side * 2.65, 0.45, 1.7), 1.8, 4.5, 1.05, 0.68, materials["team"])
        cylinder(f"hq_corner_tower_{side}", (side * 3.15, 1.65, 2.25), 0.48, 2.7, materials["metal"], vertices=20)
        cylinder(f"hq_corner_cap_{side}", (side * 3.15, 1.65, 3.62), 0.6, 0.2, materials["accent"], vertices=20)
    cube("hq_gate_frame", (0, -2.25, 1.25), (3.15, 0.36, 2.1), materials["team"], bevel=0.055)
    cube("hq_gate_recess", (0, -2.46, 1.12), (2.35, 0.18, 1.65), materials["metal"], bevel=0.025)
    for x in (-0.88, -0.44, 0, 0.44, 0.88):
        cube(f"hq_gate_rib_{x}", (x, -2.58, 1.1), (0.08, 0.08, 1.42), materials["accent"], bevel=0.01)
    for index in range(3):
        cube(f"hq_entry_step_{index}", (0, -2.68 - index * 0.3, 0.28 - index * 0.055), (2.7 + index * 0.38, 0.55, 0.18), materials["concrete"], bevel=0.025)
    cylinder("hq_radar_mast", (0, 0.55, 5.05), 0.13, 2.55, materials["metal"], vertices=16)
    sphere("hq_radar_dish", (0, 0.2, 5.95), (1.5, 0.25, 0.95), materials["team"], segments=32)
    cylinder("hq_radar_hub", (0, -0.08, 5.95), 0.2, 0.58, materials["accent"], vertices=16, rotation=(math.pi / 2, 0, 0))
    for side in (-1, 1):
        cylinder(f"hq_antenna_{side}", (side * 1.25, 0.8, 5.0), 0.04, 2.2, materials["metal"], vertices=8)
        cylinder(f"hq_antenna_light_{side}", (side * 1.25, 0.8, 6.12), 0.09, 0.18, materials["warning"], vertices=10)
    add_hazard_lights(materials, 3.45, -2.55, 0.4)


def build_barracks() -> None:
    materials = build_materials()
    cube("barracks_foundation", (0, 0, 0.16), (6.0, 5.2, 0.32), materials["concrete"], bevel=0.09)
    # Two long dormitory wings and a rear command block form an open drill yard.
    for side in (-1, 1):
        cube(f"barracks_dorm_{side}", (side * 1.95, 0.15, 0.95), (1.55, 3.95, 1.55), materials["industrial"], bevel=0.11)
        wedge(f"barracks_dorm_roof_{side}", (side * 1.95, 0.15, 1.65), 1.75, 4.15, 0.72, 0.72, materials["team"])
        for y in (-0.95, 0, 0.95):
            cube(f"barracks_window_{side}_{y}", (side * 2.76, y + 0.15, 1.05), (0.08, 0.48, 0.34), materials["glass"], bevel=0.02)
    cube("barracks_rear_block", (0, 1.75, 1.0), (2.65, 1.25, 1.65), materials["industrial"], bevel=0.1)
    wedge("barracks_rear_roof", (0, 1.75, 1.75), 2.9, 1.45, 0.72, 0.72, materials["team"])
    cube("barracks_rear_door", (0, 1.08, 0.88), (1.0, 0.12, 1.35), materials["metal"], bevel=0.025)
    for side in (-1, 1):
        cube(f"barracks_gate_post_{side}", (side * 2.55, -2.05, 0.85), (0.42, 0.42, 1.45), materials["team"], bevel=0.055)
    cube("barracks_gate_beam", (0, -2.05, 1.65), (5.4, 0.34, 0.28), materials["team"], bevel=0.045)
    cylinder("barracks_flag_mast", (-2.55, -2.05, 2.45), 0.045, 3.25, materials["metal"], vertices=10)
    cube("barracks_flag", (-2.18, -2.05, 3.35), (0.7, 0.06, 0.48), materials["accent"], bevel=0.015)
    # Weapon racks and training targets make the courtyard readable from above.
    for side in (-1, 1):
        cube(f"barracks_weapon_rack_{side}", (side * 0.9, 0.3, 0.45), (0.16, 1.15, 0.8), materials["metal"], bevel=0.018)
        for y in (-0.3, 0.05, 0.4):
            cylinder(f"barracks_rifle_{side}_{y}", (side * 0.9, y, 0.9), 0.035, 0.9, materials["accent"], vertices=8)
    for x in (-0.75, 0, 0.75):
        cylinder(f"barracks_target_post_{x}", (x, -1.15, 0.55), 0.04, 0.85, materials["metal"], vertices=8)
        cube(f"barracks_target_{x}", (x, -1.15, 1.02), (0.34, 0.12, 0.42), materials["warning"], bevel=0.03)
    add_hazard_lights(materials, 2.7, -2.24, 0.32)


def build_war_factory() -> None:
    materials = build_materials()
    cube("factory_foundation", (0, 0, 0.18), (8.4, 6.2, 0.36), materials["concrete"], bevel=0.1)
    cube("factory_rear_service_block", (0, 2.0, 1.05), (7.4, 1.5, 1.75), materials["industrial"], bevel=0.11)
    # Open twin assembly lanes replace the previous enclosed box silhouette.
    for lane in (-1, 1):
        x = lane * 1.85
        cube(f"factory_lane_floor_{lane}", (x, -0.45, 0.34), (3.2, 4.2, 0.18), materials["metal"], bevel=0.025)
        for rail_x in (x - 1.0, x + 1.0):
            cube(f"factory_lane_rail_{lane}_{rail_x}", (rail_x, -0.45, 0.48), (0.13, 4.0, 0.16), materials["warning"], bevel=0.015)
        wedge(f"factory_chassis_{lane}", (x, -0.65, 0.55), 2.45, 1.65, 0.58, 0.72, materials["team"])
        for track_side in (-1, 1):
            cube(f"factory_track_{lane}_{track_side}", (x + track_side * 1.05, -0.65, 0.5), (0.3, 1.55, 0.38), materials["rubber"], bevel=0.07)
        cylinder(f"factory_turret_ring_{lane}", (x, -0.65, 0.95), 0.48, 0.18, materials["metal"], vertices=18)
    # A suspended turret over one lane reads as assembly rather than vehicle storage.
    wedge("factory_suspended_turret", (-1.85, -0.65, 2.35), 1.2, 1.0, 0.52, 0.7, materials["accent"])
    cylinder("factory_suspended_barrel", (-1.85, -1.5, 2.52), 0.075, 1.55, materials["metal"], vertices=12, rotation=(math.pi / 2, 0, 0))
    for x in (-3.65, 0, 3.65):
        cube(f"factory_frame_post_{x}", (x, -0.15, 2.25), (0.3, 0.34, 4.2), materials["metal"], bevel=0.035)
    for y in (-1.85, 0.2, 1.75):
        cube(f"factory_roof_truss_{y}", (0, y, 4.15), (7.65, 0.28, 0.3), materials["accent"], bevel=0.035)
    for x in (-2.55, 0, 2.55):
        cube(f"factory_roof_panel_{x}", (x, 0.1, 4.28), (2.35, 4.15, 0.16), materials["team"], bevel=0.04)
    cube("factory_crane_bridge", (0, -0.55, 3.75), (7.3, 0.34, 0.34), materials["warning"], bevel=0.035)
    cube("factory_crane_trolley", (-1.85, -0.55, 3.45), (0.65, 0.7, 0.35), materials["metal"], bevel=0.035)
    cylinder("factory_crane_cable", (-1.85, -0.55, 2.9), 0.035, 0.95, materials["metal"], vertices=8)
    for lane in (-1, 1):
        wedge(f"factory_exit_ramp_{lane}", (lane * 1.85, -2.75, 0.18), 3.2, 1.4, 0.34, 0.15, materials["concrete"])
    cube("factory_control_pod", (3.25, 1.65, 2.1), (1.15, 1.15, 2.3), materials["team"], bevel=0.08)
    cube("factory_control_glass", (3.25, 1.02, 2.35), (0.85, 0.1, 0.48), materials["glass"], bevel=0.025)
    add_hazard_lights(materials, 3.55, -3.18, 0.34)


def build_refinery() -> None:
    materials = build_materials()
    cube("refinery_foundation", (0, 0, 0.18), (6.8, 6.2, 0.36), materials["concrete"], bevel=0.1)
    # A wide mineral dump with visible crystals replaces oil-industry cylinders.
    wedge("refinery_ore_pit", (-1.7, -2.0, 0.25), 3.2, 1.8, 0.85, 0.18, materials["metal"])
    cube("refinery_pit_recess", (-1.7, -2.12, 0.55), (2.55, 1.15, 0.2), materials["rubber"], bevel=0.025)
    for index, (x, y, height) in enumerate(((-2.45, -2.2, 0.9), (-1.9, -1.95, 1.2), (-1.35, -2.2, 0.82), (-0.85, -1.95, 1.05))):
        cone(f"refinery_ore_chunk_{index}", (x, y, 0.72), 0.3, 0.06, height, materials["gold"], vertices=7)
    # The belt rises visibly from the dump into a massive angular crusher.
    cube("refinery_incline_belt", (-0.55, -0.65, 1.65), (1.2, 3.5, 0.24), materials["rubber"], bevel=0.045, rotation=(math.radians(-28), 0, 0))
    for y, z in ((-1.8, 0.75), (-1.15, 1.1), (-0.5, 1.45), (0.15, 1.8)):
        cube(f"refinery_belt_support_{y}", (-0.55, y, z / 2), (1.45, 0.18, z), materials["metal"], bevel=0.025)
    wedge("refinery_crusher_base", (-0.4, 1.05, 0.35), 3.0, 2.55, 2.2, 0.68, materials["industrial"])
    wedge("refinery_crusher_head", (-0.4, 1.05, 2.55), 2.35, 1.9, 2.25, 0.55, materials["team"])
    cube("refinery_crusher_mouth", (-0.4, -0.28, 2.0), (1.8, 0.16, 0.95), materials["rubber"], bevel=0.03)
    for x in (-0.95, -0.58, -0.22, 0.15):
        cube(f"refinery_crusher_tooth_{x}", (x, -0.4, 2.0), (0.12, 0.12, 0.75), materials["warning"], bevel=0.012)
    # Square storage bunkers read as bulk mineral handling, not fuel storage.
    for x, y, height in ((1.65, 1.25, 3.25), (2.15, -0.55, 2.5)):
        wedge(f"refinery_ore_bunker_{x}_{y}", (x, y, 0.35), 1.65, 1.65, height, 0.72, materials["industrial"])
        cube(f"refinery_bunker_cap_{x}_{y}", (x, y, height + 0.25), (1.25, 1.25, 0.25), materials["team"], bevel=0.05)
        cube(f"refinery_bunker_window_{x}_{y}", (x, y - 0.85, height * 0.62), (0.75, 0.08, 0.35), materials["gold"], bevel=0.025)
    cube("refinery_sorter_bridge", (0.95, 0.85, 3.55), (2.35, 0.55, 0.48), materials["accent"], bevel=0.05)
    cylinder("refinery_sorter_drum", (0.95, 0.85, 3.55), 0.32, 2.1, materials["metal"], vertices=16, rotation=(0, math.pi / 2, 0))
    cube("refinery_control_booth", (-2.45, 1.45, 1.3), (1.05, 1.35, 1.85), materials["team"], bevel=0.08)
    cube("refinery_control_glass", (-2.45, 0.72, 1.55), (0.78, 0.1, 0.42), materials["glass"], bevel=0.025)
    add_hazard_lights(materials, 2.75, -2.72, 0.34)


def build_resource() -> None:
    materials = build_materials()
    cone("crystal_main", (0, 0, 0.52), 0.34, 0.08, 1.02, materials["gold"], vertices=7)
    cone("crystal_left", (-0.34, 0.14, 0.31), 0.22, 0.05, 0.62, materials["gold"], vertices=7, rotation=(0.2, 0.15, -0.25))
    cone("crystal_right", (0.36, -0.08, 0.28), 0.19, 0.04, 0.56, materials["gold"], vertices=7, rotation=(-0.12, 0.2, 0.2))
    cube("crystal_base", (0, 0, 0.06), (0.9, 0.72, 0.12), materials["rock"], bevel=0.045)


def build_rock() -> None:
    materials = build_materials()
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.5, location=(0, 0, 0.34))
    main = bpy.context.object
    main.name = "rock_main"
    main.scale = (1.0, 0.76, 0.67)
    finish_mesh(main, materials["rock"])
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.3, location=(0.38, -0.18, 0.2))
    side = bpy.context.object
    side.name = "rock_side"
    side.scale = (1.0, 0.9, 0.62)
    finish_mesh(side, materials["rock"])


def merge_single_material_meshes(asset_name: str) -> None:
    groups: dict[str, list[bpy.types.Object]] = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or len(obj.data.materials) != 1:
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    for material_name, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        bpy.context.view_layer.objects.active.name = f"{asset_name}_{material_name}"


def export_scene(filepath: Path, objects: list[bpy.types.Object] | None = None) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects or list(bpy.context.scene.objects):
        obj.select_set(True)
    temporary_path = filepath.with_name(f".{filepath.stem}.{os.getpid()}.tmp.glb")
    bpy.ops.export_scene.gltf(
        filepath=str(temporary_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_lights=False,
        export_cameras=False,
        export_image_format="AUTO",
    )
    last_error: OSError | None = None
    for attempt in range(8):
        try:
            os.replace(temporary_path, filepath)
            last_error = None
            break
        except OSError as error:
            last_error = error
            time.sleep(0.08 * (attempt + 1))
    if last_error is not None:
        temporary_path.unlink(missing_ok=True)
        raise last_error
    print(f"Exported {filepath}")


def decimate_scene(ratio: float) -> None:
    for obj in [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]:
        if len(obj.data.polygons) < 24:
            continue
        activate(obj)
        modifier = obj.modifiers.new("mass_battle_lod", "DECIMATE")
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)


def collapse_mass_battle_material(asset_name: str) -> None:
    material = bpy.data.materials.get("team_primary")
    if material is None:
        raise RuntimeError("team_primary material is required for mass-battle LODs")
    for obj in [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]:
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
    merge_single_material_meshes(f"{asset_name}_lod")


def is_tank_turret_object(obj: bpy.types.Object) -> bool:
    return obj.name.startswith(("Tank_Turret", "Tank_Gun", "commander_"))


def is_vehicle_turret_object(asset_name: str, obj: bpy.types.Object) -> bool:
    if asset_name == "light_tank":
        return is_tank_turret_object(obj)
    return obj.name.startswith(f"{asset_name}_turret_")


def is_vehicle_collision_body(asset_name: str, obj: bpy.types.Object) -> bool:
    if is_vehicle_turret_object(asset_name, obj):
        return False
    if asset_name == "artillery" and "_rear_spade_" in obj.name:
        return False
    return True


def is_building_collision_body(asset_name: str, obj: bpy.types.Object) -> bool:
    if asset_name not in {"machine_gun_turret", "anti_tank_turret"}:
        return True
    return not any(part in obj.name for part in ("barrel", "cannon", "muzzle"))


def merge_objects(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = name
    return merged


def merge_objects_by_material(objects: list[bpy.types.Object], name_prefix: str) -> list[bpy.types.Object]:
    groups: dict[str, list[bpy.types.Object]] = {}
    for obj in objects:
        if len(obj.data.materials) != 1 or obj.data.materials[0] is None:
            groups.setdefault(f"unmerged_{obj.name}", []).append(obj)
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)
    return [
        merge_objects(group, f"{name_prefix}_{material_name}")
        for material_name, group in groups.items()
    ]


def export_vehicle_asset(asset_name: str, builder) -> None:
    clear_scene()
    builder()
    vehicle_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    body_spec = UNIT_BODY_GEOMETRY[asset_name]
    if body_spec["shape"] != "obb":
        raise RuntimeError(f"{asset_name} requires an OBB geometry specification")
    normalize_horizontal_footprint(
        asset_name,
        vehicle_meshes,
        [obj for obj in vehicle_meshes if is_vehicle_collision_body(asset_name, obj)],
        body_spec["length"],
        body_spec["width"],
    )
    ground_scene_meshes()
    turret_meshes = [obj for obj in vehicle_meshes if is_vehicle_turret_object(asset_name, obj)]
    body_meshes = [obj for obj in vehicle_meshes if obj not in turret_meshes]
    if not body_meshes or not turret_meshes:
        raise RuntimeError(f"{asset_name} requires non-empty body and turret mesh groups")
    body_meshes = merge_objects_by_material(body_meshes, f"{asset_name}_body")
    turret_meshes = merge_objects_by_material(turret_meshes, f"{asset_name}_turret")
    vehicle_meshes = body_meshes + turret_meshes

    if asset_name == "light_tank":
        export_scene(OUTPUT_DIR / f"{asset_name}.glb", vehicle_meshes)
    export_scene(OUTPUT_DIR / f"{asset_name}_body.glb", body_meshes)
    export_scene(OUTPUT_DIR / f"{asset_name}_turret.glb", turret_meshes)

    decimate_scene(0.2)
    material = bpy.data.materials.get("team_primary")
    if material is None:
        raise RuntimeError("team_primary material is required for tank LODs")
    for obj in vehicle_meshes:
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0

    body_lod = merge_objects(body_meshes, f"{asset_name}_body_lod")
    turret_lod = merge_objects(turret_meshes, f"{asset_name}_turret_lod")
    export_scene(OUTPUT_DIR / f"{asset_name}_body_lod.glb", [body_lod])
    export_scene(OUTPUT_DIR / f"{asset_name}_turret_lod.glb", [turret_lod])
    if asset_name == "light_tank":
        export_scene(OUTPUT_DIR / f"{asset_name}_lod.glb", [body_lod, turret_lod])


def export_asset(name: str, builder) -> None:
    if name in {"scout_car", "light_tank", "heavy_tank", "artillery"}:
        export_vehicle_asset(name, builder)
        return
    clear_scene()
    builder()
    scene_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if name in BUILDING_BODY_GEOMETRY:
        body_spec = BUILDING_BODY_GEOMETRY[name]
        normalize_horizontal_footprint(
            name,
            scene_meshes,
            [obj for obj in scene_meshes if is_building_collision_body(name, obj)],
            body_spec["width"],
            body_spec["height"],
        )
    ground_scene_meshes()
    merge_single_material_meshes(name)
    export_scene(OUTPUT_DIR / f"{name}.glb")
    if name in {"worker", "soldier", "rifleman", "rocket_soldier"}:
        decimate_scene(0.24)
        collapse_mass_battle_material(name)
        export_scene(OUTPUT_DIR / f"{name}_lod.glb")


ASSETS = {
    "worker": lambda: build_infantry("worker"),
    "soldier": lambda: build_infantry("soldier"),
    "rifleman": lambda: build_infantry("rifleman"),
    "rocket_soldier": lambda: build_infantry("rocket_soldier"),
    "scout_car": build_scout_car,
    "light_tank": build_tank,
    "heavy_tank": build_heavy_tank,
    "artillery": build_artillery,
    "hq": build_hq,
    "barracks": build_barracks,
    "war_factory": build_war_factory,
    "refinery": build_refinery,
    "machine_gun_turret": build_machine_gun_turret,
    "anti_tank_turret": build_anti_tank_turret,
    "tech_center": build_tech_center,
    "resource": build_resource,
    "rock": build_rock,
}


for asset_name, asset_builder in ASSETS.items():
    export_asset(asset_name, asset_builder)

print(f"Production battlefield GLBs written to {OUTPUT_DIR}")
