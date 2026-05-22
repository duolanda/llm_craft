# Armor & Damage Type System

## Goal
Add armor types (light/heavy/concrete) and damage types (piercing/explosive) with interaction multipliers. Add Tank and Demolisher units. This creates a real strategic counter system without making ranged units over-counter HQ.

## Design

### Damage/Armor Interaction Matrix
| Attack Type | vs Light Armor | vs Heavy Armor | vs Concrete Armor |
|-------------|---------------|----------------|-------------------|
| Piercing (Soldier) | 100% | 50% | 35% |
| Explosive (Demolisher) | 50% | 150% | 60% |
| Normal (Tank) | 100% | 100% | 100% |

### Armor Types per Unit
| Unit | Armor Type |
|------|-----------|
| Worker | light |
| Soldier | light |
| Tank | heavy |
| Demolisher | light |
| HQ | concrete |
| Barracks | concrete |

### Unit Changes

**Soldier (adjusted):**
- hp: 100 → 80
- attack: 15 → 12
- attackRange: 1
- attackCooldownTicks: 2
- armorType: light
- damageType: piercing
- cost: 80

**Tank (new):**
- hp: 220
- attack: 28
- attackRange: 1
- attackCooldownTicks: 2
- armorType: heavy
- damageType: none (no damage multiplier bonus, normal damage)
- cost: 300
- speed: 1

**Demolisher (new):**
- hp: 40 (very fragile)
- attack: 25
- attackRange: 3 (long range)
- attackCooldownTicks: 4
- armorType: light
- damageType: explosive
- cost: 160
- speed: 1

### Where to Train
- Soldier: barracks (existing)
- Tank: barracks (new option)
- Demolisher: barracks (new option)

## Implementation Steps

### Step 1: shared/src/constants.ts
- Add `ARMOR_TYPES` { LIGHT: "light", HEAVY: "heavy", CONCRETE: "concrete" }
- Add `DAMAGE_TYPES` { PIERCING: "piercing", EXPLOSIVE: "explosive" }
- Add TANK and DEMOLISHER to `UNIT_TYPES`
- Add `attackCooldownTicks`, `armorType`, and `damageType` fields to UNIT_STATS type signature
- Add UNIT_STATS entries for tank and demolisher with above stats
- Update SOLDIER stats (hp 80, attack 12, plus armor/damage types)

### Step 2: shared/src/types.ts
- Export ArmorType and DamageType types
- No other type changes needed

### Step 3: server/src/Game.ts
- **RULE: Use calculateDamage helper function.**
- Add `calculateDamage(attackerStats, defenderArmorType): number` function
- Logic: get damageType from attacker, armorType from defender, look up multiplier from interaction matrix, apply to base attack damage
- Replace raw `attack` usage with `calculateDamage()` in the applyDamage/combat logic
- Respect `attackCooldownTicks` when direct `attack`, sustained `attack`, and `attack_move_unit` are already in range
- **DO NOT modify attack/defense logic on workers or HQ beyond the armor interaction** — HQ deals no damage, workers deal no damage, those are unchanged.

### Step 4: docs/ai-api-contract.md
- Update the unit stats table to include armorType and damageType columns
- Add damage interaction matrix
- Update API contract examples to show new fields

### Step 5: docs/current-mvp-reality.md
- Add armor/damage system description
- Add new unit descriptions

## Design Decisions
- Tank has no damageType — it deals raw/normal damage (no multiplier bonus or penalty)
- Tank is expensive (300 credits), durable, and intended for mid/late siege rather than opening production
- Demolisher is extremely fragile (40 HP) but has long range (3), slow attack speed, and high damage vs heavy armor
- Concrete keeps HQ/Barracks separate from heavy armor so Demolisher does not hard-counter bases
- This creates a more controlled triangle: Soldier beats Demolisher (light armor), Tank resists Soldier (heavy armor), Demolisher pressures Tank (explosive vs heavy), Tank remains the cleanest siege option
- All new units train from Barracks (no new buildings needed)
- Speed stays 1 for all units (no changes needed there)
