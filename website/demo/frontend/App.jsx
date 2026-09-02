import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { Bar } from "./components/charts/bar";
import { BarChart } from "./components/charts/bar-chart";
import { BarXAxis } from "./components/charts/bar-x-axis";
import { ChartTooltip } from "./components/charts/chart-tooltip";
import { Grid } from "./components/charts/grid";
import { ChartTooltip as StatusChartTooltip } from "./components/status-chart/chart-tooltip";
import { Grid as StatusChartGrid } from "./components/status-chart/grid";
import { Line } from "./components/status-chart/line";
import { LineChart } from "./components/status-chart/line-chart";
import { XAxis as StatusChartXAxis } from "./components/status-chart/x-axis";
import { relativeTime, useDemoStream } from "./use-demo-stream";

// Fallback data shown when the demo server is unreachable (mock mode).
const fallbackMetrics = [
  { label: "REQUESTS / MIN", value: "1,248", change: "+18.4%", tone: "positive" },
  { label: "COMPLETED", value: "184,392", change: "+12.4%", tone: "positive" },
  { label: "QUEUE DEPTH", value: "12", change: "stable", tone: "neutral" },
  { label: "P95 LATENCY", value: "847", unit: "ms", change: "−7.2%", tone: "info" },
];

const fallbackEvents = [
  { id: "projection-8f21", tone: "success", title: "Projection completed", detail: "effect_8f21 → Google Sheets", time: "2s ago" },
  { id: "worker-8f21", tone: "info", title: "Worker picked up effect", detail: "effect_8f21 / attempt 1", time: "2.4s ago" },
  { id: "outbox-8f21", tone: "brand", title: "Durable effect created", detail: "outbox row committed", time: "2.8s ago" },
  { id: "entity-1048", tone: "neutral", title: "Entity persisted", detail: "users / revision 1048", time: "3.1s ago" },
  { id: "request-1024", tone: "neutral", title: "Request accepted", detail: "request_1024 / 18ms", time: "3.3s ago" },
];

const eventFrames = [
  fallbackEvents,
  [
    { id: "projection-8f22", tone: "success", title: "Projection completed", detail: "effect_8f22 → Google Sheets", time: "now" },
    ...fallbackEvents.slice(0, 4),
  ],
  [
    { id: "projection-8f23", tone: "success", title: "Projection completed", detail: "effect_8f23 → Google Sheets", time: "now" },
    { id: "projection-8f22", tone: "success", title: "Projection completed", detail: "effect_8f22 → Google Sheets", time: "3.2s ago" },
    ...fallbackEvents.slice(0, 3),
  ],
];

const fallbackThroughputData = [18, 21, 20, 22, 21, 24, 23, 26, 24, 28, 26, 29].map((jobs, index) => ({
  slot: `${index + 1}m`,
  jobs,
}));

const fallbackServerStatusData = [99.0, 98.7, 99.4, 98.9, 99.1, 98.8, 70.0, 76.4, 90.5, 97.2, 98.6, 99.0].map(
  (score, index) => ({
    timestamp: new Date(2026, 8, 1, 10, 0, index),
    score,
  })
);

const trafficPresets = [1, 10, 100];

function getEntranceMotion(reduceMotion, delay = 0) {
  if (reduceMotion) {
    return { initial: false };
  }

  return {
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.48, delay, ease: [0.22, 1, 0.36, 1] },
  };
}

function getPressMotion(reduceMotion) {
  if (reduceMotion) {
    return {};
  }

  return {
    whileTap: { scale: 0.97 },
    transition: { type: "spring", stiffness: 500, damping: 30, mass: 0.35 },
  };
}

function getStreamMotion(reduceMotion) {
  if (reduceMotion) {
    return { initial: false };
  }

  return {
    initial: { opacity: 0, y: -12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 10 },
    transition: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
  };
}

function getTrafficStateMotion(reduceMotion) {
  if (reduceMotion) {
    return { initial: false };
  }

  return {
    initial: { opacity: 0, scale: 0.86, y: 4 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.86, y: -4 },
    transition: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
  };
}

function MetricCard({ metric, index }) {
  const reduceMotion = useReducedMotion();
  const changeClass = metric.tone === "neutral" ? "" : `reliability-demo__metric-change--${metric.tone}`;

  return (
    <motion.article className="reliability-demo__metric-card" {...getEntranceMotion(reduceMotion, 0.2 + index * 0.06)}>
      <span className="reliability-demo__metric-label">{metric.label}</span>
      <strong>
        {metric.value}
        {metric.unit ? <span className="reliability-demo__metric-unit">{metric.unit}</span> : null}
      </strong>
      <span className={`reliability-demo__metric-change ${changeClass}`}>{metric.change}</span>
    </motion.article>
  );
}

const MORPH_HEADING = "Every write has a visible path.";
const MORPH_DETAIL = "Watch a request move from SQLite authority to a durable outbox, through the worker, and into its human-facing Sheets projection.";

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function smoothStep(value) {
  const progress = clamp(value);
  return progress * progress * (3 - 2 * progress);
}

function addLine(points, start, end, count) {
  for (let index = 0; index < count; index += 1) {
    const progress = count === 1 ? 0 : index / (count - 1);
    points.push({
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
    });
  }
}

function addCircle(points, center, radius, count) {
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
}

function buildFloatingButtonTarget(width, height, count) {
  const points = [];
  const buttonDiameter = 64;
  const buttonRight = Math.max(24, width * 0.045);
  const buttonBottom = Math.max(24, height * 0.055);
  const center = {
    x: width - buttonRight - buttonDiameter / 2,
    y: height - buttonBottom - buttonDiameter / 2,
  };

  // All glyphs converge into the button center, then disappear behind it.
  addCircle(points, center, 7, count);

  return Array.from({ length: count }, (_, index) => points[Math.floor((index / count) * points.length)] ?? points[0]);
}

function wrapCanvasText(context, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  });

  if (current) {
    lines.push(current);
  }

  return lines;
}

function createMorphGlyphs(context, width, height, fontFamily) {
  const headingSize = clamp(width * 0.095, 42, 76);
  const detailSize = clamp(width * 0.025, 16, 18);
  const headingLineHeight = headingSize * 0.98;
  const detailLineHeight = detailSize * 1.48;
  const textMaxWidth = Math.min(width, 720);
  const glyphs = [];
  let y = headingSize;

  function addText(text, font, fontSize, lineHeight, color, maxWidth) {
    context.font = font;
    const lines = wrapCanvasText(context, text, maxWidth);

    lines.forEach((line) => {
      let x = 0;
      for (const character of line) {
        const advance = context.measureText(character).width;
        if (character.trim()) {
          glyphs.push({
            char: character,
            sourceX: x,
            sourceY: y,
            font,
            fontSize,
            color,
            seed: glyphs.length,
          });
        }
        x += advance;
      }
      y += lineHeight;
    });
  }

  addText(MORPH_HEADING, `650 ${headingSize}px ${fontFamily}`, headingSize, headingLineHeight, "#ffffff", textMaxWidth);
  y += 22;
  addText(MORPH_DETAIL, `300 ${detailSize}px ${fontFamily}`, detailSize, detailLineHeight, "#bac8da", Math.min(width, 600));

  return glyphs;
}

function drawMorphFrame(canvas, size, sourceRect, progress) {
  if (!canvas || !size.width || !size.height || !sourceRect?.width) {
    return;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const fontFamily = getComputedStyle(canvas).fontFamily || "sans-serif";
  const sourceGlyphs = createMorphGlyphs(context, sourceRect.width, sourceRect.height, fontFamily);
  const target = buildFloatingButtonTarget(size.width, size.height, sourceGlyphs.length);
  const glyphs = sourceGlyphs.map((glyph, index) => ({
    ...glyph,
    sourceX: glyph.sourceX + sourceRect.left,
    sourceY: glyph.sourceY + sourceRect.top,
    targetX: target[index].x,
    targetY: target[index].y,
    targetColor: index % 3 === 0 ? "#9df36e" : index % 3 === 1 ? "#bd92ff" : "#6fb8ff",
  }));
  const morph = clamp(progress);

  context.clearRect(0, 0, size.width, size.height);
  context.textBaseline = "alphabetic";
  context.textAlign = "left";

  glyphs.forEach((glyph, index) => {
    const delay = (index / Math.max(1, glyphs.length - 1)) * 0.55;
    const phase = clamp((morph - delay) / (1 - delay));
    const easedPhase = smoothStep(phase);
    const flight = Math.sin(phase * Math.PI);
    const x = glyph.sourceX + (glyph.targetX - glyph.sourceX) * easedPhase;
    const y = glyph.sourceY + (glyph.targetY - glyph.sourceY) * easedPhase - flight * (8 + (glyph.seed % 3) * 5);
    const rotation = (1 - easedPhase) * Math.sin(glyph.seed * 1.7) * 0.015 + flight * Math.sin(glyph.seed) * 0.16;
    const targetScale = 10 / glyph.fontSize;
    const scale = 1 + (targetScale - 1) * easedPhase + flight * 0.08;
    const disappearProgress = smoothStep(clamp((easedPhase - 0.5) / 0.5));
    const alpha = 1 - disappearProgress;

    context.save();
    context.translate(x, y);
    context.rotate(rotation);
    context.scale(scale, scale);
    context.font = glyph.font;
    context.fillStyle = easedPhase > 0.62 ? glyph.targetColor : glyph.color;
    context.globalAlpha = alpha;
    context.fillText(
      glyph.char,
      -context.measureText(glyph.char).width * 0.5 * easedPhase,
      glyph.fontSize * 0.34 * easedPhase,
    );
    context.restore();
  });
}

function ScrollMorphHeroCopy({ reduceMotion, isDrawerOpen, onOpenDrawer, onCloseDrawer }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const drawRef = useRef(() => {});
  const sizeRef = useRef({ width: 0, height: 0 });
  const [floatingButtonVisible, setFloatingButtonVisible] = useState(false);
  const { scrollY } = useScroll();
  const scrollProgress = useTransform(scrollY, [96, 320], [0, 1]);
  const morphProgress = useSpring(scrollProgress, {
    stiffness: 100,
    damping: 24,
    mass: 0.6,
  });

  drawRef.current = (progress) => {
    const sourceRect = stageRef.current?.getBoundingClientRect();
    drawMorphFrame(canvasRef.current, sizeRef.current, sourceRect, reduceMotion ? 0 : progress);
  };

  useMotionValueEvent(morphProgress, "change", (latest) => {
    drawRef.current(latest);
    if (isDrawerOpen && latest < 0.68) {
      onCloseDrawer?.();
    }
    const nextVisibility = !reduceMotion && !isDrawerOpen && latest > 0.78;
    setFloatingButtonVisible((currentVisibility) => (
      currentVisibility === nextVisibility ? currentVisibility : nextVisibility
    ));
  });

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) {
      return undefined;
    }

    const resizeCanvas = () => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.getContext("2d")?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      sizeRef.current = { width, height };
      drawRef.current(morphProgress.get());
    };

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(stage);
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [morphProgress]);

  useEffect(() => {
    const currentProgress = morphProgress.get();
    drawRef.current(currentProgress);
    setFloatingButtonVisible(!reduceMotion && currentProgress > 0.78);
  }, [isDrawerOpen, morphProgress, reduceMotion]);

  const floatingButtonOpacity = useTransform(morphProgress, [0.78, 0.94], [0, 1]);
  const floatingButtonStyle = {
    opacity: isDrawerOpen ? 0 : floatingButtonOpacity,
    y: useTransform(morphProgress, [0.78, 1], [18, 0]),
    scale: useTransform(morphProgress, [0.78, 1], [0.9, 1]),
  };

  function handleFloatingButtonClick() {
    onOpenDrawer?.();
  }

  return (
    <div className="reliability-demo__hero-copy">
      <p className="reliability-demo__kicker">OBSERVABILITY FIRST</p>
      <div className="reliability-demo__morph-stage" ref={stageRef}>
        <canvas
          className="reliability-demo__morph-canvas"
          ref={canvasRef}
          aria-hidden="true"
        />
        <div className="reliability-demo__morph-accessible">
          <h1 id="reliability-demo-title">{MORPH_HEADING}</h1>
          <p>{MORPH_DETAIL}</p>
        </div>
      </div>
      <motion.button
        className="reliability-demo__morph-fab"
        type="button"
        aria-hidden={!floatingButtonVisible}
        aria-label="Run a write through the pipeline"
        aria-expanded={isDrawerOpen}
        tabIndex={floatingButtonVisible ? 0 : -1}
        style={{ ...floatingButtonStyle, pointerEvents: floatingButtonVisible ? "auto" : "none" }}
        onClick={handleFloatingButtonClick}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 10h11M10 5l5 5-5 5" />
        </svg>
      </motion.button>
    </div>
  );
}

function TrafficDrawer({
  open,
  onClose,
  trafficCount,
  setTrafficCount,
  trafficState,
  onGenerateTraffic,
  reduceMotion,
}) {
  const isProcessing = trafficState !== "idle";
  const expandedState = { width: "min(520px, calc(100vw - 32px))", height: 382, borderRadius: 22, padding: 24, opacity: 1 };
  const collapsedState = { width: 64, height: 64, borderRadius: 999, padding: 0, opacity: 1 };

  return (
    <AnimatePresence>
      {open ? (
        <motion.section
          className={`reliability-demo__traffic-drawer reliability-demo__traffic-drawer--${trafficState}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby="traffic-drawer-title"
          initial={{ width: 64, height: 64, borderRadius: 999, padding: 0, opacity: 0.82 }}
          animate={isProcessing ? collapsedState : expandedState}
          exit={{ width: 64, height: 64, borderRadius: 999, padding: 0, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 180, damping: 24, mass: 0.85 }}
        >
          <motion.div
            className="reliability-demo__traffic-drawer-status"
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: isProcessing ? 1 : 0, scale: isProcessing ? 1 : 0.7 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 22 }}
          >
            {trafficState === "sending" ? (
              <motion.span
                className="reliability-demo__traffic-drawer-spinner"
                animate={reduceMotion ? undefined : { rotate: 360 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.9, ease: "linear", repeat: Infinity }}
              />
            ) : (
              <svg viewBox="0 0 20 20">
                <path d="m4.5 10.5 3.4 3.2 7.6-7.4" />
              </svg>
            )}
          </motion.div>
          <motion.div
            className="reliability-demo__traffic-drawer-content"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: isProcessing ? 0 : 1, y: isProcessing ? 8 : 0, transition: reduceMotion ? { duration: 0 } : { delay: isProcessing ? 0 : 0.14, duration: 0.28, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
          >
            <div className="reliability-demo__traffic-drawer-head">
              <div>
                <p className="reliability-demo__kicker">TEST THE PIPELINE</p>
                <h2 id="traffic-drawer-title">Generate traffic</h2>
              </div>
              <motion.button
                className="reliability-demo__traffic-drawer-close"
                type="button"
                aria-label="Close traffic drawer"
                onClick={onClose}
                {...getPressMotion(reduceMotion)}
              >
                <span aria-hidden="true">×</span>
              </motion.button>
            </div>
            <p className="reliability-demo__traffic-drawer-description">
              Push sample writes through the full path and watch each stage respond.
            </p>
            <div className="reliability-demo__traffic-drawer-actions" aria-label="Traffic controls">
              <div className="reliability-demo__traffic-drawer-presets">
                {trafficPresets.map((count) => (
                  <motion.button
                    className={trafficCount === count ? "is-selected" : ""}
                    type="button"
                    data-traffic-count={count}
                    aria-pressed={trafficCount === count}
                    onClick={() => setTrafficCount(count)}
                    key={count}
                    {...getPressMotion(reduceMotion)}
                  >
                    {count} request{count === 1 ? "" : "s"}
                  </motion.button>
                ))}
              </div>
              <motion.button
                className={`reliability-demo__traffic-button reliability-demo__traffic-drawer-submit reliability-demo__traffic-button--${trafficState}`}
                type="button"
                data-hook="generate-traffic"
                aria-label={trafficState === "idle" ? "Generate traffic" : trafficState === "sending" ? "Generating traffic" : "Traffic queued"}
                disabled={trafficState !== "idle"}
                onClick={onGenerateTraffic}
                {...getPressMotion(reduceMotion)}
              >
                <span className="reliability-demo__traffic-button-content">
                  <AnimatePresence initial={false} mode="wait">
                    {trafficState === "idle" ? (
                      <motion.span className="reliability-demo__traffic-button-label" key="idle" {...getTrafficStateMotion(reduceMotion)}>
                        Generate traffic
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                  <TrafficButtonIcon active={trafficState !== "idle"} reduceMotion={reduceMotion} />
                </span>
              </motion.button>
            </div>
            <div className="reliability-demo__traffic-drawer-note" aria-live="polite">
              {trafficState === "idle" ? `Ready to send ${trafficCount} sample request${trafficCount === 1 ? "" : "s"}` : null}
              {trafficState === "sending" ? `Sending ${trafficCount} sample request${trafficCount === 1 ? "" : "s"}` : null}
              {trafficState === "complete" ? `Queued ${trafficCount} sample request${trafficCount === 1 ? "" : "s"}` : null}
              {trafficState === "idle" ? <><span aria-hidden="true"> · </span><code>onGenerateTraffic(count)</code></> : null}
            </div>
          </motion.div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

function EventStream({ streamEvents, connected }) {
  const reduceMotion = useReducedMotion();
  const [fallbackIndex, setFallbackIndex] = useState(0);

  useEffect(() => {
    if (connected || reduceMotion) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setFallbackIndex((currentIndex) => (currentIndex + 1) % eventFrames.length);
    }, 3200);

    return () => window.clearInterval(intervalId);
  }, [connected, reduceMotion]);

  const visibleEvents =
    connected && streamEvents.length > 0
      ? streamEvents.map((event) => ({
          id: event.id,
          tone: event.tone,
          title: event.title,
          detail: event.detail,
          time: relativeTime(event.at),
        }))
      : eventFrames[fallbackIndex] ?? fallbackEvents;

  return (
    <motion.article className="reliability-demo__panel" data-hook="event-log" {...getEntranceMotion(reduceMotion, 0.48)}>
      <div className="reliability-demo__panel-heading">
        <div>
          <span className="reliability-demo__metric-label">LIVE EVENT STREAM</span>
          <h2>Recent activity</h2>
        </div>
      </div>
      <div className="reliability-demo__events">
        <AnimatePresence initial={false} mode="popLayout">
          {visibleEvents.map((event, index) => (
            <motion.div
              className={`reliability-demo__event${index === 0 ? " reliability-demo__event--latest" : ""}`}
              key={event.id}
              layout={!reduceMotion}
              {...getStreamMotion(reduceMotion)}
            >
              <span className={`reliability-demo__event-dot reliability-demo__event-dot--${event.tone}`} aria-hidden="true" />
              <div><strong>{event.title}</strong><span>{event.detail}</span></div>
              <time>{event.time}</time>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

function WorkerThroughput({ throughputSeries, latestThroughput, connected, workerStats }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.article className="reliability-demo__panel" data-hook="worker-panel" {...getEntranceMotion(reduceMotion, 0.54)}>
      <div className="reliability-demo__panel-heading">
        <div>
          <span className="reliability-demo__metric-label">WORKER THROUGHPUT</span>
          <h2>Processing performance</h2>
        </div>
        <strong className="reliability-demo__throughput">
          {latestThroughput ?? 0} <small>jobs/s</small>
        </strong>
      </div>
      <div className="reliability-demo__chart reliability-demo__chart--bklit" aria-label="Worker throughput chart">
        <BarChart
          data={throughputSeries}
          xDataKey="slot"
          aspectRatio="4 / 1"
          margin={{ top: 10, right: 12, bottom: 24, left: 12 }}
          barGap={0.35}
          animationDuration={800}
        >
          <Grid horizontal fadeHorizontal stroke="rgba(255, 255, 255, 0.12)" strokeDasharray="3,4" />
          <Bar dataKey="jobs" fill="var(--demo-blue)" stroke="var(--demo-blue)" lineCap="round" />
          <BarXAxis maxLabels={6} />
          <ChartTooltip showDatePill={false} />
        </BarChart>
      </div>
      <div className="reliability-demo__worker-stats">
        <div><span>P50 WAIT</span><strong>{workerStats.p50 ? `${workerStats.p50}ms` : "—"}</strong></div>
        <div><span>P95 DURATION</span><strong>{workerStats.p95 ? `${workerStats.p95}ms` : "—"}</strong></div>
        <div><span>FAILED</span><strong className="reliability-demo__failed-number">{workerStats.failedPct ?? "—"}</strong></div>
      </div>
    </motion.article>
  );
}

export default function ReliabilityDemo() {
  const [trafficCount, setTrafficCount] = useState(1);
  const [trafficState, setTrafficState] = useState("idle");
  const [trafficDrawerOpen, setTrafficDrawerOpen] = useState(false);
  const trafficTimeoutsRef = useRef([]);
  const reduceMotion = useReducedMotion();
  const { connected, snapshot, events: streamEvents, generateBurst } = useDemoStream();

  // Rolling chart series built from live snapshots; seeded with fallback data
  // so the charts render immediately (mock mode keeps them static).
  const [throughputSeries, setThroughputSeries] = useState(fallbackThroughputData);
  const [healthSeries, setHealthSeries] = useState(fallbackServerStatusData);

  useEffect(() => {
    if (!snapshot) return;
    const label = new Date(snapshot.ts).toLocaleTimeString("en-US", { hour12: false, minute: "2-digit", second: "2-digit" });
    setThroughputSeries((previous) => [...previous.slice(-11), { slot: label, jobs: snapshot.metrics.throughputPerSecond }]);
    setHealthSeries((previous) => [...previous.slice(-11), { timestamp: new Date(snapshot.ts), score: snapshot.healthScore }]);
  }, [snapshot]);

  const liveMetrics = snapshot?.metrics ?? null;
  const liveLagSec = connected ? snapshot?.syncLagSec ?? null : null;
  const throughputData = connected && throughputSeries.length > 0 ? throughputSeries : fallbackThroughputData;
  const serverStatusData = connected && healthSeries.length > 0 ? healthSeries : fallbackServerStatusData;
  const metricCards = connected
    ? [
        { label: "REQUESTS / MIN", value: (liveMetrics?.requestsPerMinute ?? 0).toLocaleString("en-US"), change: "LIVE", tone: "info" },
        { label: "COMPLETED", value: (liveMetrics?.completedTotal ?? 0).toLocaleString("en-US"), change: "LIVE", tone: "positive" },
        { label: "QUEUE DEPTH", value: String(snapshot?.outbox?.pending ?? 0), change: (snapshot?.outbox?.pending ?? 0) > 0 ? "draining" : "drained", tone: "neutral" },
        { label: "SHEET LAG", value: liveLagSec === null ? "—" : String(liveLagSec), unit: "s", change: liveLagSec === null ? "offline" : liveLagSec > 0 ? "sheets catching up" : "caught up", tone: "info" },
        { label: "P95 LATENCY", value: String(liveMetrics?.p95LatencyMs ?? 0), unit: "ms", change: "LIVE", tone: "info" },
      ]
    : fallbackMetrics;
  const workerStats = {
    p50: connected ? liveMetrics?.p50LatencyMs : null,
    p95: connected ? liveMetrics?.p95LatencyMs : null,
    failedPct: connected
      ? ((liveMetrics && liveMetrics.completedTotal > 0 ? (snapshot.outbox.failed / liveMetrics.completedTotal) * 100 : 0).toFixed(2))
      : null,
  };

  useEffect(() => () => {
    trafficTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
  }, []);

  function handleGenerateTraffic() {
    if (trafficState !== "idle") {
      return;
    }

    setTrafficState("sending");
    generateBurst(trafficCount).then((accepted) => {
      if (!accepted) {
        window.setTimeout(() => setTrafficState("idle"), 900);
        return;
      }
      trafficTimeoutsRef.current = [
        window.setTimeout(() => setTrafficState("complete"), 420),
        window.setTimeout(() => {
          setTrafficState("idle");
          setTrafficDrawerOpen(false);
        }, 2700),
      ];
    });
  }

  return (
    <main className="reliability-demo" aria-labelledby="reliability-demo-title">
      <header className="reliability-demo__topbar">
        <div className="reliability-demo__eyebrow">
          <span>HIKOUTEI <span className="reliability-demo__slash">/</span> LIVE RELIABILITY DEMO</span>
        </div>
        <div className="reliability-demo__topbar-meta">
          <span className="reliability-demo__environment">DEMO ENVIRONMENT</span>
          <span className="reliability-demo__connection">
            <span className="reliability-demo__status-dot" aria-hidden="true" />
            {connected ? "Operational" : "Offline — mock data"}
          </span>
        </div>
      </header>

      <section className="reliability-demo__hero">
        <ScrollMorphHeroCopy
          reduceMotion={reduceMotion}
          isDrawerOpen={trafficDrawerOpen}
          onOpenDrawer={() => setTrafficDrawerOpen(true)}
          onCloseDrawer={() => setTrafficDrawerOpen(false)}
        />

        <motion.div className="reliability-demo__system-card" data-hook="overall-status" {...getEntranceMotion(reduceMotion, 0.16)}>
          <div className="reliability-demo__system-card-head">
            <span className="reliability-demo__metric-label">SYSTEM STATUS</span>
            <span className="reliability-demo__system-status">
              {!connected ? "Offline" : (snapshot?.healthScore ?? 100) >= 95 ? "Operational" : "Degraded"}
            </span>
          </div>
          <div className="reliability-demo__system-card-body">
            <span>{connected ? "SQLite authority + async Sheets projection" : "Start the demo server to stream live data"}</span>
            <strong>{connected ? (snapshot?.healthScore ?? 100) : "99.0"} <small>/ 100</small></strong>
          </div>
          <div
            className="reliability-demo__chart reliability-demo__system-chart"
            data-hook="server-status-chart"
            aria-label="Server health score over twelve seconds, dropping to 70 before recovering to 99"
          >
            <LineChart
              data={serverStatusData}
              xDataKey="timestamp"
              aspectRatio="4 / 1"
              margin={{ top: 8, right: 12, bottom: 28, left: 12 }}
              animationDuration={850}
            >
              <StatusChartGrid
                horizontal
                fadeHorizontal
                rowTickValues={[70, 80, 90, 100]}
                highlightRowValues={[70]}
                highlightRowStroke="rgb(216 53 30 / 72%)"
                highlightRowStrokeDasharray="3,3"
                stroke="rgb(168 195 222 / 20%)"
                strokeDasharray="3,4"
              />
              <Line dataKey="score" stroke="var(--demo-brand-hover)" strokeWidth={2.5} />
              <StatusChartXAxis numTicks={4} />
              <StatusChartTooltip showDatePill={false} />
            </LineChart>
          </div>
          <div className="reliability-demo__system-card-footer">
            <span><i aria-hidden="true" /> Minimum {Math.min(...serverStatusData.map((point) => point.score)).toFixed(1)}</span>
            <span>{serverStatusData.length} second window</span>
          </div>
        </motion.div>
      </section>

      <section className="reliability-demo__metrics" data-hook="metrics" aria-label="System metrics">
        {metricCards.map((metric, index) => <MetricCard key={metric.label} metric={metric} index={index} />)}
      </section>

      <section className="reliability-demo__lower-grid">
        <EventStream streamEvents={streamEvents} connected={connected} />
        <WorkerThroughput
          throughputSeries={throughputData}
          latestThroughput={connected ? snapshot?.metrics?.throughputPerSecond : null}
          connected={connected}
          workerStats={workerStats}
        />
      </section>

      <TrafficDrawer
        open={trafficDrawerOpen}
        onClose={() => setTrafficDrawerOpen(false)}
        trafficCount={trafficCount}
        setTrafficCount={setTrafficCount}
        trafficState={trafficState}
        onGenerateTraffic={handleGenerateTraffic}
        reduceMotion={reduceMotion}
      />
    </main>
  );
}

function TrafficButtonIcon({ active, reduceMotion }) {
  const spring = reduceMotion
    ? { duration: 0 }
    : { type: "spring", mass: 1, stiffness: 45, damping: 15 };

  return (
    <span className="reliability-demo__traffic-button-icon" aria-hidden="true">
      <motion.svg
        className="reliability-demo__traffic-button-base-icon"
        viewBox="0 0 24 24"
        animate={active ? { opacity: 0, rotate: 45 } : { opacity: 1, rotate: 0 }}
        transition={spring}
      >
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 8v8M8 12h8" />
      </motion.svg>
      <motion.svg
        className="reliability-demo__traffic-button-active-icon"
        viewBox="0 0 24 24"
        animate={active ? { opacity: 1, rotate: 0 } : { opacity: 0, rotate: -45 }}
        transition={spring}
      >
        <path d="m7.5 12.25 3 3 6.25-6.5" />
      </motion.svg>
    </span>
  );
}
