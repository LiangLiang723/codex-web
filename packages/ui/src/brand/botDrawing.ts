import type { BotMood } from "./contract.js";

export const BOT_VIEW_BOX = "0 0 64 64";
const CENTER = 32;
const RADIUS = 26;
const TAU = Math.PI * 2;

interface Pose {
  lift: number;
  squash: number;
  silhouette: number;
  yaw: number;
  pitch: number;
  lids: number;
}

const neutral: Pose = { lift: 0, squash: 0, silhouette: 0, yaw: 0.2, pitch: -0.1, lids: 0 };
const thinking: Pose = {
  ...neutral,
  silhouette: 0.22,
  yaw: 0.29,
  pitch: -0.22,
  lids: 0.1,
};
const working: Pose = { ...neutral, silhouette: 0.35, yaw: -0.08, pitch: 0.09 };

type Keyframe = readonly [seconds: number, pose: Pose];

// 位移、姿势、轮廓与眼睑独立取样，眨眼直接作为 clip 内的关键帧。
const clips: Record<BotMood, readonly Keyframe[]> = {
  idle: [
    [0, neutral],
    [0.9, { ...neutral, lift: -1.5, yaw: 0.14 }],
    [2.2, { ...neutral, lift: 0.6, yaw: 0.23, pitch: -0.04 }],
    [2.34, { ...neutral, lift: 0.25, yaw: 0.23, lids: 1 }],
    [2.52, { ...neutral, lift: 0.2, yaw: 0.23 }],
    [3.8, { ...neutral, lift: -0.8, yaw: 0.09, pitch: -0.15 }],
    [5.2, neutral],
  ],
  thinking: [
    [0, thinking],
    [0.8, { ...thinking, lift: -1.3, yaw: 0.15, lids: 0.24 }],
    [1.5, { ...thinking, squash: -0.025, yaw: -0.04, pitch: -0.28 }],
    [2.7, thinking],
  ],
  working: [
    [0, working],
    [0.32, { ...working, lift: 1.3, squash: 0.06, silhouette: 0.78, yaw: -0.17 }],
    [0.84, { ...working, lift: -2.4, squash: -0.055, yaw: 0.16 }],
    [1.26, { ...working, lift: -1.1, squash: -0.02, yaw: 0.25 }],
    [1.42, { ...working, lift: 0.4, squash: 0.036, yaw: 0.15, lids: 1 }],
    [1.6, { ...working, yaw: 0.12 }],
    [2.25, working],
  ],
};

const curve = (t: number, a: number, b: number) => {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
};

function easeInOut(progress: number) {
  // 根据时钟解出 Bézier 的 x，再读取同一点的 y。
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < 10; index++) {
    const mid = (lower + upper) / 2;
    if (curve(mid, 0.4, 0.58) < progress) lower = mid;
    else upper = mid;
  }
  return curve((lower + upper) / 2, 0, 1);
}

const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const mixPose = (a: Pose, b: Pose, t: number): Pose => ({
  lift: mix(a.lift, b.lift, t),
  squash: mix(a.squash, b.squash, t),
  silhouette: mix(a.silhouette, b.silhouette, t),
  yaw: mix(a.yaw, b.yaw, t),
  pitch: mix(a.pitch, b.pitch, t),
  lids: mix(a.lids, b.lids, t),
});

function sampleClip(mood: BotMood, seconds: number): Pose {
  const frames = clips[mood];
  const end = frames.at(-1)!;
  const time = seconds % end[0];
  const next = frames.findIndex(([frameTime]) => frameTime > time);
  const [startTime, start] = frames[next - 1]!;
  const [endTime, finish] = frames[next]!;
  return mixPose(start, finish, easeInOut((time - startTime) / (endTime - startTime)));
}

type Point = readonly [x: number, y: number];

function samples(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * TAU;
    return { x: Math.cos(angle), y: Math.sin(angle), angle };
  });
}

const outlineSamples = samples(40).map(({ x, y, angle }) => ({
  x,
  y,
  radius: RADIUS * (1 + 0.024 * Math.cos(3 * angle - Math.PI / 2)),
  roundedShape: RADIUS * (1 + 0.085 * Math.cos(3 * angle - Math.PI / 2)),
}));
const eyeSamples = samples(14);
const formattedPoint = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;

function smoothOutline(points: readonly Point[]) {
  const last = points.at(-1)!;
  const first = points[0]!;
  let path = `M${formattedPoint((last[0] + first[0]) / 2, (last[1] + first[1]) / 2)}`;
  for (const [index, [x, y]] of points.entries()) {
    const [nextX, nextY] = points[(index + 1) % points.length]!;
    path += `Q${formattedPoint(x, y)} ${formattedPoint((x + nextX) / 2, (y + nextY) / 2)}`;
  }
  return path + "Z";
}

function draw(pose: Pose) {
  const centerY = CENTER + pose.lift;
  const scaleX = 1 + pose.squash;
  const scaleY = 1 - pose.squash;
  const body = smoothOutline(
    outlineSamples.map(({ x, y, radius, roundedShape }) => {
      const r = mix(radius, roundedShape, pose.silhouette);
      return [CENTER + x * r * scaleX, centerY + y * r * scaleY];
    }),
  );
  const yawCos = Math.cos(pose.yaw);
  const yawSin = Math.sin(pose.yaw);
  const pitchCos = Math.cos(pose.pitch);
  const pitchSin = Math.sin(pose.pitch);
  // 眼睛沿球面旋转再正交投影，转向时眼睛宽度随球面透视一起变化。
  const eyes = [-0.31, 0.23].map((centerX) =>
    smoothOutline(
      eyeSamples.map(({ x, y }) => {
        const eyelid = 1 - pose.lids * 0.94;
        const u = centerX + 0.109 * x - 0.072 * y * eyelid;
        const v = -0.08 - (centerX + 0.05) * 0.28 + (0.17 * y + 0.027 * x) * eyelid;
        const z = Math.sqrt(1 - u * u - v * v);
        const projectedX = u * yawCos + z * yawSin;
        const projectedY = v * pitchCos - (z * yawCos - u * yawSin) * pitchSin;
        return [CENTER + projectedX * RADIUS * scaleX, centerY + projectedY * RADIUS * scaleY];
      }),
    ),
  );
  return body + eyes.join("");
}

export const staticBotPaths = {
  idle: draw(neutral),
  thinking: draw(thinking),
  working: draw(working),
};

interface Spring {
  value: number;
  speed: number;
}

function stepSpring(spring: Spring, target: number, step: number) {
  const acceleration = 170 * (target - spring.value) - 23 * spring.speed;
  spring.speed += acceleration * step;
  spring.value += spring.speed * step;
}

export function createBotDrawing(mood: BotMood) {
  const gazeX: Spring = { value: 0, speed: 0 };
  const gazeY: Spring = { value: 0, speed: 0 };
  let seconds = 0;
  let remainder = 0;
  const step = 1 / 120;

  return (delta: number, targetX: number, targetY: number) => {
    seconds += delta;
    remainder += delta;
    while (remainder >= step) {
      stepSpring(gazeX, targetX, step);
      stepSpring(gazeY, targetY, step);
      remainder -= step;
    }
    const pose = sampleClip(mood, seconds);
    return draw({ ...pose, yaw: pose.yaw + gazeX.value, pitch: pose.pitch + gazeY.value });
  };
}
