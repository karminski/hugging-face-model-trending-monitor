import { z } from "zod";
import type { Config } from "../config.js";
import { type CalendarContext, describeContext } from "./context.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const sceneReplySchema = z.object({
  scene_title: z.string().min(1).max(20),
  ticker: z.array(z.string().min(1).max(60)).min(1).max(6),
  scene_js: z.string().min(80),
});

export type SceneReply = z.infer<typeof sceneReplySchema>;

export const SCENE_SIZE = { width: 262, height: 288 };
export const ANIMATION = { frames: 12, fps: 4 };

export const SYSTEM_PROMPT = `你是一名像素艺术家兼 three.js 工程师，为一块 400x300 的单色（纯黑白）反射式液晶日历创作每日画面。
画面左侧是一块 ${SCENE_SIZE.width}x${SCENE_SIZE.height}（接近正方形、略竖）的场景面板。场景会被缩小到一半分辨率渲染、转灰度、抖动成 1-bit 黑白像素画（静态封面用 Atkinson，动画帧用 Bayer 有序抖动）。

请根据用户给出的日期、时间、节气、节日、天气，构思一个温暖、有意境的小场景，并输出 JSON：
{
  "scene_title": "4~8 个汉字的场景标题",
  "ticker": ["2~4 句中文短文案，每句 10~26 字，像微小说或俳句，呼应时间/天气/节气/节日，不要编造具体数字"],
  "scene_js": "three.js 场景代码字符串"
}

scene_js 必须是一个 ES module，导出默认函数：
export default function build({ THREE, scene, camera, renderer, rng, ctx, t }) { ... }
- THREE 是完整的 three.js（r187）模块；scene、camera(PerspectiveCamera, fov 40, aspect ${(SCENE_SIZE.width / SCENE_SIZE.height).toFixed(3)})、renderer(WebGLRenderer，已开启 shadowMap) 已经创建好。
- 你可以修改 camera.position / camera.fov / camera.lookAt（修改 fov 后调用 camera.updateProjectionMatrix()），但不要修改 renderer 的尺寸、不要调用 renderer.render、不要创建 canvas 或 DOM。
- 只使用 three.js 内置几何体（Box/Sphere/Cylinder/Cone/Torus/Plane/Circle/Lathe/Extrude/Shape 等）和 MeshLambertMaterial / MeshToonMaterial / MeshBasicMaterial / MeshStandardMaterial / PointsMaterial / LineBasicMaterial。
- 禁止加载任何外部资源：不要 TextureLoader、GLTFLoader、fetch、import 其他模块、图片或字体。
- 随机数只能用 rng()（返回 [0,1)，已按日期固定种子），不要用 Math.random()。
- ctx 是当天信息对象：{ weather: { kind }, isNight, hour, solarTerm, festivals, dayPeriod }，可以用来细化画面。

循环动画（非常重要）：
- 画面是一段 ${ANIMATION.frames} 帧、${ANIMATION.fps}fps、首尾无缝衔接的循环动画。宿主会对 t = 0, 1/${ANIMATION.frames}, ..., 1 分别调用一次 build，每次都是全新的 scene，并且 rng 会重置为相同的种子；所以静止内容每帧天然一致，你只需要让运动依赖 t。
- 所有运动必须是 t 的周期函数，周期正好为 1，保证 t=1 与 t=0 的画面完全相同：
  - 往复/摇摆/闪烁：Math.sin(2 * Math.PI * (t * k + phase))，k 为正整数。
  - 下落/飘移/上升（雪、雨、烟、云、花瓣）：先用 rng() 生成初始位置 y0，再用 y = bottom + ((((y0 - bottom) - t * k * H) % H) + H) % H，H 是循环区间高度，k 为正整数。
  - 旋转：angle = 2 * Math.PI * t * k。
- 相机、灯光、大物体保持静止；只让小元素运动（雪、雨、烟、火苗、灯笼摇摆、水波、云、星星闪烁、风车等），每帧变化的面积要明显可见但不超过画面的 1/4。
- 不要用 Date、performance.now 或 requestAnimationFrame，动画只能由 t 决定。

其他代码约束：
- 不要在场景里画文字。
- 代码要短而健壮（不超过 200 行），不能有无限循环，不能有语法错误。

单色画面的美术要求（非常重要）：
- 用灰度思考颜色，只用 4~5 个明度层级，例如 0x111111、0x555555、0x999999、0xdddddd、0xffffff。相邻物体明度要拉开差距。
- 大面积区域（天空、墙面、地面、桌面）必须接近纯白（≥ 0xdddddd）或接近纯黑（≤ 0x222222）；中间灰只用于小面积的阴影和细节，否则抖动后会变成大片网纹噪点。
- 构图简洁：一个清晰的主体放在画面中部，大块的明暗面，轮廓分明，留出干净的天空或背景。避免大量细碎小物体。
- 设置 scene.background 为一个浅色（白天）或深色（夜晚）的 THREE.Color，必要时加 scene.fog 营造层次。
- 至少一盏 DirectionalLight（castShadow）加一盏弱的 AmbientLight/HemisphereLight，让体积感清晰；主要物体 castShadow / receiveShadow。
- 天气要体现出来：下雪用白色小方块/小球散落、下雨用细长斜线或细盒子、雾天用 scene.fog、晴天可有太阳或月亮、雷雨可有闪电折线。
- 节日或节气时加入应景元素（如春节灯笼、中秋月亮与月饼、冬至饺子、清明柳枝、端午龙舟等），用几何体概括出造型。

只输出 JSON，不要任何解释或 Markdown 代码块。`;

export function userPrompt(ctx: CalendarContext): string {
  return `今天的信息：\n${describeContext(ctx)}\n\n请输出 json。`;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("reply contains no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseSceneReply(text: string): SceneReply {
  const parsed = sceneReplySchema.safeParse(extractJson(text));
  if (!parsed.success) throw new Error(`JSON does not match schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function chat(cfg: Config["llm"], messages: ChatMessage[]): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
  };
  if (cfg.jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM returned no content: ${text.slice(0, 500)}`);
  return content;
}
