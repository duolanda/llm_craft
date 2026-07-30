export function LegendPanel() {
  return (
    <div className="legend-grid">
      <div className="legend-section">
        <div className="legend-title">阵营颜色</div>
        <div className="legend-row">
          <LegendItem shape="circle" color="#ff2a4a" label="红方（AI 1）" />
          <LegendItem shape="circle" color="#00e5ff" label="蓝方（AI 2）" />
        </div>
      </div>

      <div className="legend-section">
        <div className="legend-title">单位 / 建筑</div>
        <div className="legend-row">
          <LegendItem shape="circle" color="#aaa" label="Worker 工程装" />
          <LegendItem shape="diamond" color="#aaa" label="Soldier 突击兵" />
          <LegendItem shape="diamond" color="#8df2a6" label="Rifleman 机枪兵" />
          <LegendItem shape="triangle" color="#ff8840" label="Rocket 反装甲兵" />
          <LegendItem shape="bar" color="#7dd3fc" label="Light tank 轻坦模型" />
          <LegendItem shape="square" color="#aaa" label="3D 建筑" />
        </div>
      </div>

      <div className="legend-section">
        <div className="legend-title">建筑类型</div>
        <div className="legend-row">
          <LegendItem shape="square" color="#c45fff" label="HQ 指挥中心" />
          <LegendItem shape="square" color="#2979ff" label="兵营" />
          <LegendItem shape="square" color="#ff8840" label="战车工厂" />
        </div>
      </div>

      <div className="legend-section">
        <div className="legend-title">地形 / 资源</div>
        <div className="legend-row">
          <LegendItem shape="dot" color="#ffb300" label="资源矿石" />
          <LegendItem shape="square" color="#4a5568" label="障碍物" />
        </div>
      </div>
    </div>
  );
}

function LegendItem({
  shape,
  color,
  label,
}: {
  shape: "circle" | "square" | "dot" | "bar" | "diamond" | "triangle";
  color: string;
  label: string;
}) {
  const iconStyle: React.CSSProperties = {
    width: shape === "dot" ? 6 : shape === "bar" ? 14 : 10,
    height: shape === "bar" ? 3 : shape === "dot" ? 6 : 10,
    borderRadius: shape === "circle" ? "50%" : shape === "bar" ? 1 : 2,
    background: color,
    border: shape === "square" ? `1.5px solid ${color}` : undefined,
    boxShadow: `0 0 6px ${color}66`,
    flexShrink: 0,
    transform: shape === "diamond" ? "rotate(45deg)" : undefined,
    clipPath: shape === "triangle" ? "polygon(50% 0, 100% 100%, 0 100%)" : undefined,
  };

  return (
    <div className="legend-item">
      <span style={iconStyle} />
      <span className="legend-label">{label}</span>
    </div>
  );
}
