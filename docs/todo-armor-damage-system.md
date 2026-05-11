# Armor & Damage Type System

## Goal
Add armor types (light/heavy) and damage types (piercing/explosive) with interaction multipliers. Add Tank and Demolisher units. This creates a real strategic counter system.

## Design

### Damage/Armor Interaction Matrix
| Attack Type | vs Light Armor | vs Heavy Armor |
|-------------|---------------|----------------|
| Piercing (Soldier) | 100% | 50% |
| Explosive (Demolisher) | 50% | 150% |

### Armor Types per Unit
| Unit | Armor Type |
|------|-----------|
| Worker | light |
| Soldier | light |
| Tank | heavy |
| Demolisher | light |
| HQ | heavy |
| Barracks | heavy |

### Unit Changes

**Soldier (adjusted):**
- hp: 100 → 80
- attack: 15 → 12
- attackRange: 1
- armorType: light
- damageType: piercing
- cost: 80

**Tank (new):**
- hp: 200
- attack: 20
- attackRange: 1
- armorType: heavy
- damageType: none (no damage multiplier bonus, normal damage)
- cost: 150
- speed: 1

**Demolisher (new):**
- hp: 40 (very fragile)
- attack: 25
- attackRange: 3 (long range)
- armorType: light
- damageType: explosive
- cost: 120
- speed: 1

### Where to Train
- Soldier: barracks (existing)
- Tank: barracks (new option)
- Demolisher: barracks (new option)

## Implementation Steps

### Step 1: shared/src/constants.ts
- Add `ARMOR_TYPES` { LIGHT: "light", HEAVY: "heavy" }
- Add `DAMAGE_TYPES` { PIERCING: "piercing", EXPLOSIVE: "explosive" }
- Add TANK and DEMOLISHER to `UNIT_TYPES`
- Add `armorType` and `damageType` fields to UNIT_STATS type signature
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
- Demolisher is extremely fragile (40 HP) but has long range (3) and high damage vs heavy armor
- This creates a rock-paper-scissors dynamic: Soldier beats Demolisher (light armor), Tank beats Soldier (heavy armor), Demolisher beats Tank (explosive vs heavy)
- All new units train from Barracks (no new buildings needed)
- Speed stays 1 for all units (no changes needed there)
