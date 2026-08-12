/**
 * 图谱的 3D 那一半（spec 2026-08-12）：盘、节点、边、三档 LOD、能飞进去的相机。
 *
 * 这里**一个坐标都不算** —— 布局是服务端的纯函数（graph-layout.ts），这边照画。
 * 数据进（SceneModel）、事件出（onSelect）、别的它不知道：不 fetch、不读库、
 * 不认识面板的其余部分。
 *
 * ## 视觉语言（2026-08-12 重画）
 *
 * 第一版是灰球堆，用户判定丑。这一版贴面板自己的美学（云海 + 暖沙金 + 发丝线）：
 *
 * - **节点是星，不是石头**：辉光 sprite（加色混合）+ 亮芯，大小仍由爆炸半径说话
 * - **盘是发丝环**，和环形轨道同族 —— 一圈细线 + 几乎看不见的盘面
 * - **边是弧**，不是直线段；选中才亮，加色混合让交叠处自己发光
 * - **雾和星尘**给纵深 —— 远的自己暗下去，不用手调透明度
 * - 配色全取自面板：沙金 / 玫瑰 / 灰绿，低饱和（设计稿 §3 禁仪表盘警示色）
 */
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** 一层一个色，循环用。低饱和暖色系 —— 和面板同一族，别加高饱和。 */
const LAYER_COLORS = [0xd9b28e, 0xa97879, 0x8e9bb3, 0x9fae8e, 0xc4a2b8, 0xb3a08e];
const SELECT_COLOR = 0xe8b04a;      // 选中：暖金（太阳那族）
const DEP_COLOR = 0x8fbf9d;         // 它依赖谁：灰绿（--approved 的近亲）
const DEPENDENT_COLOR = 0xdf9d66;   // 谁依赖它：暖橙
const VIOLATION_COLOR = 0xc46a6a;   // 向上的边：玫瑰，常亮但极细
const FOG_COLOR = 0x151220;         // 和面板的夜空同族
const NEAR_DISTANCE = 26;           // 近景档：比这近就把配料单牌翻出来
const MID_DISTANCE = 80;            // 中景档：比这近就浮出该盘全部标签

/** 辉光贴图：一张 canvas 画的径向渐变。所有星共用，按 material.color 染色。 */
function glowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const brush = canvas.getContext("2d");
  const fade = brush.createRadialGradient(
    size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  fade.addColorStop(0, "rgba(255,255,255,1)");
  fade.addColorStop(0.25, "rgba(255,255,255,.55)");
  fade.addColorStop(0.6, "rgba(255,255,255,.12)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  brush.fillStyle = fade;
  brush.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export function createGraphScene(container, callbacks) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;   // 没有 WebGL —— 调用方降级到列表
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "graph-labels";
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  // 雾给纵深：远处的星自己暗下去。密度按整座塔的尺度在 fitCamera 里调。
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.006);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 5000);

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  // 「飞进去」的一半就是这两行：没有最小距离的地板，滚轮一直钻到星跟前。
  controls.minDistance = 2;
  controls.maxDistance = 1200;

  /** prefers-reduced-motion：飞行改瞬移，别的动画本来就没有。 */
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const glow = glowTexture();
  let model = null;
  let groups = [];          // 每个节点一个 Group（芯 + 辉光 + 命中球 + 标签）
  let hitTargets = [];      // raycast 只打这些（比星大一圈，好点中）
  let labels = [];
  let headline = new Set(); // 远景档也带标签的那几个（每盘爆炸半径前三）
  let selected = null;
  let edgeGroup = new THREE.Group();     // 选中态的边，重选就清
  let standingGroup = new THREE.Group(); // 常亮的：盘、星尘、违规边、断头边
  let nearCard = null;
  let flight = null;
  scene.add(edgeGroup, standingGroup);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function wipe(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }

  const coreRadius = (node) => 0.55 + Math.sqrt(node.blast) * 0.22;

  /**
   * 边画成微微上拱的弧，不是直线段 —— 118 个节点的盘上，直线会齐刷刷贴着盘面
   * 排成栅栏；弧让每条边有自己的身段，加色混合下交叠处自己发亮。
   */
  function arc(from, to, color, opacity) {
    const middle = from.clone().add(to).multiplyScalar(0.5);
    middle.y += Math.max(1.6, from.distanceTo(to) * 0.14);
    const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  }

  function dashedStub(from, color) {
    const out = from.clone().add(new THREE.Vector3(0, 4.2, 0));
    const geometry = new THREE.BufferGeometry().setFromPoints([from, out]);
    const stub = new THREE.Line(geometry, new THREE.LineDashedMaterial({
      color, transparent: true, opacity: 0.7, dashSize: 0.9, gapSize: 0.7,
    }));
    stub.computeLineDistances();
    return stub;
  }

  const centerOf = (index) => groups[index].position.clone();

  /** 星尘：一层稀疏的远景点，给「在一个空间里」的感觉。静止，不闪。 */
  function sprinkleDust(radius, top) {
    const positions = [];
    for (let i = 0; i < 240; i += 1) {
      // 均匀壳层分布；确定性伪随机（黄金角步进），刷新不换天
      const a = i * 2.39996;
      const b = i * 0.61803 * Math.PI * 2;
      const r = radius * (2.2 + (i % 17) * 0.22);
      positions.push(
        r * Math.cos(a) * Math.cos(b * 0.31),
        top / 2 + r * 0.75 * Math.sin(b),
        r * Math.sin(a) * Math.cos(b * 0.31),
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position",
      new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xe1c9a8, size: 1.1, sizeAttenuation: false,
      transparent: true, opacity: 0.28, depthWrite: false,
    }));
  }

  /** 把一张 SceneModel 摆出来。重进图谱就整个重建 —— 图不缓存，场景也不缝补。 */
  function setModel(next) {
    wipe(edgeGroup);
    wipe(standingGroup);
    for (const group of groups) scene.remove(group);
    groups = []; hitTargets = []; labels = []; headline = new Set();
    selected = null; nearCard = null;
    model = next;

    // 盘：发丝环 + 几乎看不见的盘面。和环形轨道同族，不抢星的戏。
    for (const layer of model.layers) {
      const tint = LAYER_COLORS[layer.index % LAYER_COLORS.length];

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(layer.radius, 0.055, 8, 128),
        new THREE.MeshBasicMaterial({
          color: tint, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0, layer.y - 1.2, 0);
      standingGroup.add(rim);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(layer.radius, 96),
        new THREE.MeshBasicMaterial({
          color: tint, transparent: true, opacity: 0.045,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.copy(rim.position);
      standingGroup.add(floor);

      const tag = document.createElement("div");
      tag.className = "graph-layer-tag";
      tag.textContent = `${layer.key} · ${layer.count}`;
      const anchor = new CSS2DObject(tag);
      anchor.position.set(-layer.radius - 2.5, layer.y - 1.2, 0);
      standingGroup.add(anchor);
    }

    // 每盘爆炸半径前三名，远景档也留名字 —— 其余的名字飞近了才浮出来。
    const byLayer = new Map();
    for (const [index, node] of model.nodes.entries()) {
      byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), index]);
    }
    for (const members of byLayer.values()) {
      members.sort((a, b) => model.nodes[b].blast - model.nodes[a].blast);
      for (const index of members.slice(0, 3)) {
        if (model.nodes[index].blast > 0) headline.add(index);
      }
    }

    // 节点：星（亮芯 + 辉光）。命中球比星大一圈 —— raycast 打得中才算能点。
    for (const [index, node] of model.nodes.entries()) {
      const tint = LAYER_COLORS[node.layer % LAYER_COLORS.length];
      const radius = coreRadius(node);
      const group = new THREE.Group();
      group.position.set(node.x, node.y, node.z);

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 18, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff4e2 }),
      );
      core.userData.index = index;

      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, color: tint, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(radius * 7);

      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(radius * 1.8, 1.3), 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.userData.index = index;

      const text = document.createElement("div");
      text.className = "graph-node-label";
      text.textContent = node.name;
      const label = new CSS2DObject(text);
      label.position.set(0, radius + 1.6, 0);
      label.visible = false;

      group.add(core, halo, hit, label);
      group.userData = { core, halo, tint, radius };
      scene.add(group);
      groups.push(group);
      hitTargets.push(hit);
      labels.push(label);
    }

    // 常亮的两种「不对劲」，都极细 —— 它们是批注，不是主角。
    for (const edge of model.edges) {
      if (!edge.upward) continue;
      standingGroup.add(
        arc(centerOf(edge.from), centerOf(edge.to), VIOLATION_COLOR, 0.30));
    }
    for (const gap of model.dangling) {
      standingGroup.add(dashedStub(centerOf(gap.from), VIOLATION_COLOR));
    }

    const top = model.layers.length > 0
      ? model.layers[model.layers.length - 1].y : 0;
    const widest = Math.max(4, ...model.layers.map((layer) => layer.radius));
    standingGroup.add(sprinkleDust(widest, top));

    fitCamera();
    select(null);
  }

  /** 取景：3/4 视角把整座塔框进来 —— 第一眼看到的是结构，不是某张盘的内部。 */
  function fitCamera() {
    if (!model || model.layers.length === 0) return;
    const top = model.layers[model.layers.length - 1].y;
    const widest = Math.max(4, ...model.layers.map((layer) => layer.radius));
    const focus = new THREE.Vector3(0, top / 2, 0);
    const envelope = Math.hypot(top / 2, widest) + 6;
    const distance = envelope / Math.sin((camera.fov / 2) * (Math.PI / 180));
    const direction = new THREE.Vector3(0.55, 0.42, 1).normalize();
    controls.target.copy(focus);
    camera.position.copy(focus.clone().add(direction.multiplyScalar(distance)));
    // 雾跟着尺度走：塔越高雾越薄，保证顶层不糊。
    scene.fog.density = 1.6 / Math.max(distance, 60);
    controls.update();
  }

  /** 选中：亮边。绿弧 = 它依赖谁，橙弧 = 谁依赖它，其余的星退成背景。 */
  function select(index) {
    selected = index;
    wipe(edgeGroup);
    if (nearCard) { nearCard.parent?.remove(nearCard); nearCard = null; }

    const dependencies = new Set();
    const dependents = new Set();
    if (index !== null && model) {
      for (const edge of model.edges) {
        if (edge.from === index) dependencies.add(edge.to);
        if (edge.to === index) dependents.add(edge.from);
      }
      for (const to of dependencies) {
        edgeGroup.add(arc(centerOf(index), centerOf(to), DEP_COLOR, 0.75));
      }
      for (const from of dependents) {
        edgeGroup.add(arc(centerOf(from), centerOf(index), DEPENDENT_COLOR, 0.65));
      }
    }

    for (const [other, group] of groups.entries()) {
      const { core, halo, tint, radius } = group.userData;
      const related = other === index
        || dependencies.has(other) || dependents.has(other);
      const color = other === index ? SELECT_COLOR
        : dependencies.has(other) ? DEP_COLOR
          : dependents.has(other) ? DEPENDENT_COLOR : tint;
      halo.material.color.setHex(color);
      halo.material.opacity = index === null ? 0.9 : related ? 1 : 0.22;
      halo.scale.setScalar(radius * (other === index ? 10 : 7));
      core.material.color.setHex(related || index === null ? 0xfff4e2 : 0x8a8494);
    }
    callbacks.onSelect?.(index);
  }

  /** 飞到一颗星跟前 —— 「飞进去」的另一半。reduced-motion 下瞬移。 */
  function flyTo(index) {
    const target = centerOf(index);
    const destination = target.clone().add(new THREE.Vector3(9, 5, 9));
    if (still) {
      controls.target.copy(target);
      camera.position.copy(destination);
      controls.update();
      return;
    }
    flight = {
      fromTarget: controls.target.clone(), toTarget: target,
      fromCamera: camera.position.clone(), toCamera: destination,
      start: performance.now(), ms: 750,
    };
  }

  /** 近景档：把选中节点的配料单牌挂到它旁边。内容是调用方给的 DOM。 */
  function showNearCard(index, element) {
    if (selected !== index) return;
    if (nearCard) nearCard.parent?.remove(nearCard);
    nearCard = new CSS2DObject(element);
    nearCard.position.set(0, groups[index].userData.radius + 2.4, 0);
    nearCard.visible = false;
    groups[index].add(nearCard);
  }

  function pick(event) {
    const box = labelRenderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
    pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hitTargets, false)[0];
    return hit === undefined ? null : hit.object.userData.index;
  }

  let downAt = null;
  labelRenderer.domElement.addEventListener("pointerdown", (event) => {
    downAt = { x: event.clientX, y: event.clientY };
  });
  labelRenderer.domElement.addEventListener("pointerup", (event) => {
    // 拖动是转相机，不是点选 —— 挪超过 6px 就不当点击。
    if (downAt === null || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) return;
    select(pick(event));
  });
  labelRenderer.domElement.addEventListener("dblclick", (event) => {
    const index = pick(event);
    if (index !== null) { select(index); flyTo(index); }
  });

  /** 三档 LOD，每帧按相机距离拨。 */
  function updateTiers() {
    if (!model) return;
    const layerNear = new Map();
    for (const layer of model.layers) {
      const distance = camera.position.distanceTo(new THREE.Vector3(0, layer.y, 0));
      layerNear.set(layer.index, distance < MID_DISTANCE);
    }
    for (const [index, label] of labels.entries()) {
      const node = model.nodes[index];
      label.visible = headline.has(index) || layerNear.get(node.layer) === true
        || index === selected;
    }
    if (nearCard && selected !== null) {
      nearCard.visible = camera.position.distanceTo(centerOf(selected)) < NEAR_DISTANCE;
    }
  }

  let disposed = false;
  function frame(now) {
    if (disposed) return;
    requestAnimationFrame(frame);
    if (flight !== null) {
      const t = Math.min(1, (now - flight.start) / flight.ms);
      const ease = t * (2 - t);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, ease);
      camera.position.lerpVectors(flight.fromCamera, flight.toCamera, ease);
      if (t >= 1) flight = null;
    }
    controls.update();
    updateTiers();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
  }
  const watcher = new ResizeObserver(resize);
  watcher.observe(container);
  resize();
  requestAnimationFrame(frame);

  return {
    setModel,
    select,
    flyTo,
    showNearCard,
    dispose() {
      disposed = true;
      watcher.disconnect();
      glow.dispose();
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
