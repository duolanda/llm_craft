#!/usr/bin/env python3
"""
CLI vs CLI: Two bot agents fight using the llmcraft CLI.
No API keys needed - server auto-creates a headless game on first session.
"""
import subprocess, json, time, sys, os

CLI = os.path.join(os.path.dirname(__file__), "..", "node_modules", ".bin", "llmcraft")
BASE = "http://localhost:3001"
TOTAL_TICKS = 300  # 150 seconds at 500ms/tick

def run(*args):
    cmd = [CLI] + list(args) + ["--base-url", BASE]
    out = subprocess.check_output(cmd, stderr=subprocess.PIPE).decode()
    return json.loads(out)

def info(msg):
    print(f"  {msg}", flush=True)

# Join the game
p1 = run("session", "use", "--player", "player_1")
p2 = run("session", "use", "--player", "player_2")
print(f"\n🎮 Player 1: {p1['sessionId']}")
print(f"🎮 Player 2: {p2['sessionId']}")

last_eco_msg = {}
tick = 0
while tick < TOTAL_TICKS:
    try:
        tick += 5

        # === Player 1 turn ===
        state1 = run("state")
        tick = state1.get("tick", tick)
        units1 = run("units")
        bld1 = run("buildings")
        eco1 = run("me")
        credits1 = eco1.get("data", {}).get("player", {}).get("credits", 0)
        idle1 = [u for u in units1.get("data", {}).get("units", []) if u.get("state") == "idle"]
        workers1 = [u for u in idle1 if u.get("type") == "worker"]
        soldiers1 = [u for u in units1.get("data", {}).get("units", []) if u.get("type") == "soldier" and u.get("state") != "idle"]
        idle_soldiers1 = [u for u in units1.get("data", {}).get("units", []) if u.get("type") == "soldier" and u.get("state") == "idle"]
        ready_bld1 = [b for b in bld1.get("data", {}).get("buildings", []) if b.get("type") == "barracks"]

        if credits1 != last_eco_msg.get("p1"):
            info(f"[tick {tick}] P1: {credits1}c, {len(workers1)} workers idle, {len(soldiers1)+len(idle_soldiers1)} soldiers")
            last_eco_msg["p1"] = credits1

        # Gather idle workers
        if workers1:
            for w in workers1[:3]:
                run("gather", "--unit", w["id"])

        # Build barracks if enough credits and no barracks
        if credits1 >= 300 and not ready_bld1:
            idle_workers = run("units", "--type", "worker", "--idle")
            builders = idle_workers.get("data", {}).get("units", [])
            if builders:
                run("build", "barracks", "--unit", builders[0]["id"], "--at", "6,8")

        # Train soldiers if barracks ready
        if ready_bld1 and credits1 >= 100:
            run("train", "soldier", "--building", ready_bld1[0]["id"])

        # Attack with soldiers
        if soldiers1 or idle_soldiers1:
            try:
                result = subprocess.run(
                    [CLI, "units", "--type", "soldier", "--unplanned", "--base-url", BASE],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    soldiers_json = json.loads(result.stdout)
                    attack_units = soldiers_json.get("data", {}).get("units", [])
                    if attack_units:
                        pipe_out = subprocess.run(
                            [CLI, "target", "enemy-hq", "--base-url", BASE],
                            input=result.stdout, capture_output=True, text=True, timeout=5
                        )
                        if pipe_out.returncode == 0:
                            subprocess.run(
                                [CLI, "attack", "--base-url", BASE],
                                input=pipe_out.stdout, capture_output=True, timeout=5
                            )
            except:
                pass

        # === Player 2 turn (same strategy, mirrored) ===
        units2 = run("units")
        bld2 = run("buildings")
        eco2 = run("me")
        credits2 = eco2.get("data", {}).get("player", {}).get("credits", 0)
        idle2 = [u for u in units2.get("data", {}).get("units", []) if u.get("state") == "idle"]
        workers2 = [u for u in idle2 if u.get("type") == "worker"]
        soldiers2 = [u for u in units2.get("data", {}).get("units", []) if u.get("type") == "soldier"]
        ready_bld2 = [b for b in bld2.get("data", {}).get("buildings", []) if b.get("type") == "barracks"]

        if credits2 != last_eco_msg.get("p2"):
            info(f"[tick {tick}] P2: {credits2}c, {len(workers2)} workers idle, {len(soldiers2)} soldiers")
            last_eco_msg["p2"] = credits2

        if workers2:
            for w in workers2[:3]:
                run("gather", "--unit", w["id"])

        if credits2 >= 300 and not ready_bld2:
            idle_workers2 = run("units", "--type", "worker", "--idle")
            builders2 = idle_workers2.get("data", {}).get("units", [])
            if builders2:
                run("build", "barracks", "--unit", builders2[0]["id"], "--at", "14,12")

        if ready_bld2 and credits2 >= 100:
            run("train", "soldier", "--building", ready_bld2[0]["id"])

        if soldiers2:
            try:
                result2 = subprocess.run(
                    [CLI, "units", "--type", "soldier", "--unplanned", "--base-url", BASE],
                    capture_output=True, text=True, timeout=5
                )
                if result2.returncode == 0:
                    soldiers_json2 = json.loads(result2.stdout)
                    attack_units2 = soldiers_json2.get("data", {}).get("units", [])
                    if attack_units2:
                        pipe_out2 = subprocess.run(
                            [CLI, "target", "enemy-hq", "--base-url", BASE],
                            input=result2.stdout, capture_output=True, text=True, timeout=5
                        )
                        if pipe_out2.returncode == 0:
                            subprocess.run(
                                [CLI, "attack", "--base-url", BASE],
                                input=pipe_out2.stdout, capture_output=True, timeout=5
                            )
            except:
                pass

        # Let the game advance roughly 10 ticks.
        time.sleep(5)

    except subprocess.CalledProcessError as e:
        print(f"  ⚠️  Error at tick {tick}: {e}")
        time.sleep(5)
        continue
    except json.JSONDecodeError:
        print(f"  ⚠️  JSON parse error at tick {tick}")
        time.sleep(5)
        continue

# Final state
print(f"\n🏁 Game over after {tick} ticks")
