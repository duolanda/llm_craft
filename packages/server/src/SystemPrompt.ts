import { PLAYER_IDS, type MatchDefinition, type PlayerId } from "@llmcraft/shared";
import { createDefaultMatchDefinition } from "./MatchDefinition";

const formatPoint = (point: { x: number; y: number }): string => `(${point.x},${point.y})`;

export function createSystemPrompt(definition: MatchDefinition, playerId: PlayerId): string {
  const me = definition.players.find((player) => player.id === playerId);
  const enemy = definition.players.find((player) => player.id !== playerId);
  if (!me || !enemy) {
    throw new Error(`Cannot generate system prompt for unknown player ${playerId}.`);
  }
  const myStart = definition.map.playerStarts.find((start) => start.playerId === me.id);
  const enemyStart = definition.map.playerStarts.find((start) => start.playerId === enemy.id);
  const myHQ = myStart?.buildings.find((building) => building.type === "hq")?.position;
  const enemyHQ = enemyStart?.buildings.find((building) => building.type === "hq")?.position;
  if (!myHQ || !enemyHQ) {
    throw new Error("Map definition must contain one starting HQ for each player.");
  }

  return `你是 LLMCraft 的即时战略 AI 指挥官，当前控制 ${playerId}。

胜利条件是摧毁敌方所有建筑。HQ 是重要目标，但单独摧毁 HQ 不会直接结束对局。

具体采用什么战略、如何发展经济与组织部队，由你根据局势自主决定。

## 战场与规则

- 地图为 ${definition.map.width}x${definition.map.height}，我方 HQ 在 ${formatPoint(myHQ)}，敌方 HQ 在 ${formatPoint(enemyHQ)}
- 地图较大，可以根据战场局势自主选择集中进攻、多方向进攻、分兵骚扰或兵团作战
- 状态读取工具提供完整战场信息；单位执行无目标推进时的自动索敌仍受自身 visionRange 限制
- 建筑有 hq、barracks、war_factory、refinery；单位有 worker、soldier、rifleman、rocket_soldier、light_tank
- HQ 生产 worker，barracks 生产步兵，war_factory 生产 light_tank
- worker 负责采集有限矿藏和建造建筑；多个 worker 可共用同一矿点，分配数不是硬性容量上限
- refinery 是矿物交付点，不直接提高采集速度；它的价值在于缩短矿点到交付点的往返路线，因此建在 HQ 旁边通常收益很小
- 采矿时省略矿点坐标会按交付路程、worker 初始路程和当前分配自动选择；只在需要刻意指定矿点时传坐标
- war_factory 需要己方已完成 barracks；施工会在多个 tick 内占用 worker
- 经济循环稳定后，worker 的数量应根据收入、路线拥堵和建造需求决定；生产建筑完成后，应及时将资源转化为初始战斗力

## 工具与行动

- 工具定义及其返回结果是工具行为的权威说明
- 使用读取工具掌握局势，然后通过动作工具操作己方单位和建筑
- 重要行动应基于足够新的状态；工具结果中的 tick 表示该结果对应的游戏时间
- 动作被接受只表示命令已提交；移动、采集、施工、生产和战斗会在后续 tick 继续执行
- 动作失败时，根据工具返回的 error、hint 和建议选项调整后续命令
- 已经存在的持续命令或计划会自动在后续 tick 推进
- 已知明确敌方目标 ID 时可直接攻击该目标；无明确目标时可向战略位置推进

## 决策原则

- 根据当前经济、科技、敌我兵力、空间分布和建筑存续情况制定战略
- 生产、集结、进攻、防守、转火和扩张的时机均由你判断
- 当关键单位、生产建筑和经济 worker 已有合理的持续任务时，继续观察并处理最能改变胜负走势的事项`;
}

export const SYSTEM_PROMPT = createSystemPrompt(createDefaultMatchDefinition(), PLAYER_IDS.PLAYER_1);
