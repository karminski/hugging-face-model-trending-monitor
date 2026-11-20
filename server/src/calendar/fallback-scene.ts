import type { CalendarContext } from "./context.js";
import type { SceneReply } from "./llm.js";

/** Hand-written scene used when the LLM is not configured or every attempt failed. */
const FALLBACK_JS = `
export default function build({ THREE, scene, camera, rng, ctx, t }) {
  const wrap = (v, h) => ((v % h) + h) % h;
  const night = ctx.isNight;
  const kind = ctx.weather.kind;
  scene.background = new THREE.Color(night ? 0x222222 : 0xeeeeee);
  if (kind === "fog") scene.fog = new THREE.Fog(scene.background, 6, 16);
  camera.position.set(0, 3.2, 9.5);
  camera.lookAt(0, 1.4, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, night ? 0.5 : 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, night ? 1.2 : 2.2);
  sun.position.set(-5, 8, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  scene.add(sun);

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(7, 48), mat(kind === "snow" ? 0xffffff : 0x999999));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const house = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2), mat(0xdddddd));
  body.position.y = 0.9;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.3, 4), mat(0x333333));
  roof.position.y = 2.45;
  roof.rotation.y = Math.PI / 4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1, 0.05), mat(0x222222));
  door.position.set(0.3, 0.5, 1.01);
  const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.05), new THREE.MeshBasicMaterial({ color: night ? 0xffffff : 0x333333 }));
  win.position.set(-0.6, 1.1, 1.01);
  for (const m of [body, roof, door, win]) { m.castShadow = true; m.receiveShadow = true; house.add(m); }
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.8, 0.35), mat(0x333333));
  chimney.position.set(-0.6, 2.6, -0.2);
  chimney.castShadow = true;
  house.add(chimney);
  house.rotation.y = -0.45;
  scene.add(house);

  const puffMat = new THREE.MeshLambertMaterial({ color: night ? 0x999999 : 0xffffff });
  for (let i = 0; i < 4; i++) {
    const p = wrap(i / 4 + t, 1);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.18 + p * 0.3, 12, 8), puffMat);
    const base = new THREE.Vector3(-0.6, 3.1, -0.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.45);
    puff.position.set(base.x + p * 1.2 + Math.sin(2 * Math.PI * p) * 0.15, base.y + p * 2.2, base.z);
    scene.add(puff);
  }

  for (let i = 0; i < 3; i++) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.7), mat(0x333333));
    trunk.position.y = 0.35;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 7), mat(kind === "snow" ? 0xdddddd : 0x555555));
    crown.position.y = 1.5;
    tree.add(trunk, crown);
    tree.traverse((o) => { o.castShadow = true; });
    tree.position.set(2.6 + i * 0.9, 0, -1.5 + i * 0.9 - rng() * 0.5);
    tree.scale.setScalar(0.8 + rng() * 0.5);
    scene.add(tree);
  }

  if (kind === "clear" || kind === "cloudy") {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), new THREE.MeshBasicMaterial({ color: night ? 0xffffff : 0x555555 }));
    orb.position.set(-3, 5.2, -3);
    scene.add(orb);
  }

  if (kind === "snow" || kind === "rain" || kind === "drizzle" || kind === "thunder") {
    const n = kind === "snow" ? 220 : 160;
    const geo = kind === "snow" ? new THREE.BoxGeometry(0.08, 0.08, 0.08) : new THREE.BoxGeometry(0.02, 0.45, 0.02);
    const m = new THREE.MeshBasicMaterial({ color: night ? 0xffffff : (kind === "snow" ? 0xffffff : 0x555555) });
    const drops = new THREE.InstancedMesh(geo, m, n);
    const o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const speed = kind === "snow" ? 1 : 3;
      const x = (rng() - 0.5) * 12 + (kind === "snow" ? 0.2 * Math.sin(2 * Math.PI * (t + rng())) : 0);
      o.position.set(x, wrap(rng() * 7 - t * speed * 7, 7), (rng() - 0.5) * 8);
      o.rotation.z = kind === "snow" ? rng() : 0.25;
      o.updateMatrix();
      drops.setMatrixAt(i, o.matrix);
    }
    scene.add(drops);
  }
}
`;

export function fallbackScene(ctx: CalendarContext): SceneReply {
  const line = {
    clear: ctx.isNight ? "月光铺满了院子" : "阳光晒暖了屋檐",
    cloudy: "云慢慢走过屋顶",
    overcast: "天色压得很低",
    fog: "雾把远处藏了起来",
    drizzle: "细雨沾湿了窗台",
    rain: "雨点敲着屋檐",
    snow: "雪落满了屋檐",
    thunder: "雷声在远处滚过",
  }[ctx.weather.kind];
  return {
    scene_title: "小屋",
    ticker: [`${ctx.dayPeriod}，${line}。`, "灯还亮着，有人在等你回家。"],
    scene_js: FALLBACK_JS,
  };
}
