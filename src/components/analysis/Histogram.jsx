export default function Histogram({ values, color, bins = 10, height = "100%" }) {
  const buckets = Array(bins).fill(0);
  values.forEach((v) => {
    const idx = Math.min(Math.floor(v * bins), bins - 1);
    buckets[idx]++;
  });
  const max = Math.max(...buckets, 1);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
      {buckets.map((count, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${(count / max) * 100}%`,
            background: `linear-gradient(to top, ${color}50, ${color}18)`,
            border: `1px solid ${color}35`,
            borderRadius: "4px 4px 0 0",
            minHeight: 2,
            transition: "height 0.3s ease",
          }}
          title={`${(i / bins).toFixed(1)}–${((i + 1) / bins).toFixed(1)}: ${count}`}
        />
      ))}
    </div>
  );
}
