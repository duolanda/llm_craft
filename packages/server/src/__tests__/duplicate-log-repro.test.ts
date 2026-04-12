import { describe, expect, it } from "vitest";
import { Game } from "../Game";
import { AIStatePackageBuilder } from "../AIStatePackageBuilder";

describe("Duplicate log investigation", () => {
  it("should reveal duplicate logs in events and feedback", () => {
    const game = new Game();

    // 获取 player_1 的一个 worker
    const state = game.getState();
    const worker = state.players[0].units[0];

    // 发送一个 move 命令，目标点被阻挡（会触发 move_adjusted）
    game.queueCommand({
      id: "test_move",
      type: "move",
      unitId: worker.id,
      position: { x: 1, y: 1 },  // HQ 旁边，肯定被阻挡
      playerId: "player_1",
    });
    game.processCommands();

    // 现在构建 AI 状态包（模拟 AI 回合）
    const aiPackage = AIStatePackageBuilder.build("player_1", game.getState(), game);

    console.log("\n=== eventsSinceLastCall ===");
    aiPackage.eventsSinceLastCall.forEach(log => {
      console.log(`[tick=${log.tick}] type=${log.type} msg=${log.message}`);
    });

    // 该测试已不再需要——aiFeedbackSinceLastCall 字段已删除，events 已包含所有 AI 相关日志
    // 验证：eventsSinceLastCall 中不应再出现完全重复的日志（同 tick+同 message）
    const eventMessages = new Set(aiPackage.eventsSinceLastCall.map(l => `${l.tick}-${l.message}`));

    // eventsSinceLastCall 本身不应有重复（同一 tick 同一消息）
    const duplicates = [...eventMessages].filter(msg => {
      const count = aiPackage.eventsSinceLastCall.filter(l => `${l.tick}-${l.message}` === msg).length;
      return count > 1;
    });

    console.log("\n=== Duplicates within eventsSinceLastCall ===", duplicates);

    if (duplicates.length > 0) {
      console.log("\n❌ 同一日志在 eventsSinceLastCall 内重复出现！");
    } else {
      console.log("\n✅ eventsSinceLastCall 内部无重复");
    }

    expect(duplicates).toHaveLength(0);
  });
});
