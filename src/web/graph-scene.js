/**
 * 图谱的 3D 那一半（spec 2026-08-12）：盘、节点、边、三档 LOD、能飞进去的相机。
 *
 * 这里**一个坐标都不算** —— 布局是服务端的纯函数（graph-layout.ts），这边照画。
 * 数据进（SceneModel）、事件出（onSelect / onNear），别的它不知道：不 fetch、
 * 不读库、不认识面板的其余部分。
 *
 * 配色贴面板的规矩（设计稿 §3）：低饱和、暖沙金、不用仪表盘警示色；
 * 状态不只靠颜色 —— 违规的边同时是「向上」的（几何本身在说话）。
 */
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** 一层一个色，循环用。低饱和沙金系 —— 和面板同一族。 */
const LAYER_COLORS = [0xd9b28e, 0xa97879, 0x8e9bb3, 0x9fae8e, 0xc4a2b8, 0xb3a08e];
const SELECT_COLOR = 0xe8b04a;      // 选中：暖金
const DEP_COLOR = 0x7fae8e;         // 它依赖谁：灰绿（--approved 的近亲）
const DEPENDENT_COLOR = 0xd98a5f;   // 谁依赖它：暖橙
const VIOLATION_COLOR = 0xc46a6a;   // 向上的边：玫瑰红，常亮
const NEAR_DISTANCE = 26;           // 近景档：比这近就把配料单牌翻出来
const MID_DISTANCE = 95;            // 中景档：比这近就浮出该盘全部标签

export function createGraphScene(container, callbacks) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;   // 没有 WebGL —— 调用方降级到列表 + 平面图
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "graph-labels";
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
  camera.position.set(70, 90, 130);

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
  sun.position.set(80, 160, 60);
  scene.add(sun);

  const controls = new OrbitControls(camera, labelRenderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // 「飞进去」的一半就是这两行：没有最小距离的地板，滚轮一直钻到节点跟前。
  controls.minDistance = 2;
  controls.maxDistance = 900;

  /** prefers-reduced-motion：飞行改瞬移，别的动画本来就没有。 */
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let model = null;
  let meshes = [];          // 节点球，下标 = SceneModel.nodes 下标
  let labels = [];          // 节点标签（CSS2D）
  let selected = null;
  let edgeGroup = new THREE.Group();     // 选中态的边，重选就清
  let standingGroup = new THREE.Group(); // 常亮的：盘、违规边、断头边
  let nearCard = null;                   // 近景那块配料单牌
  let flight = null;                     // 进行中的飞行 {from,to,start,ms}
  scene.add(edgeGroup, standingGroup);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function clearGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }

  function nodeRadius(node) {
    return 0.9 + Math.sqrt(node.blast) * 0.32;
  }

  function line(a, b, color, opacity, dashed = false) {
    const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 1.2, gapSize: 0.8 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const drawn = new THREE.Line(geometry, material);
    if (dashed) drawn.computeLineDistances();
    return drawn;
  }

  const centerOf = (index) => meshes[index].position.clone();

  /** 把一张 SceneModel 摆出来。重进图谱就整个重建 —— 图不缓存，场景也不缝补。 */
  function setModel(next) {
    clearGroup(edgeGroup);
    clearGroup(standingGroup);
    for (const label of labels) label.parent?.remove(label);
    for (const mesh of meshes) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    meshes = []; labels = []; selected = null; nearCard = null;
    model = next;

    // 盘：半透的圆柱薄片 + 层名牌。
    for (const layer of model.layers) {
      const color = LAYER_COLORS[layer.index % LAYER_COLORS.length];
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(layer.radius, layer.radius, 0.5, 64),
        new THREE.MeshStandardMaterial({
          color, transparent: true, opacity: 0.10, roughness: 0.9,
        }),
      );
      disc.position.set(0, layer.y - 1.6, 0);
      standingGroup.add(disc);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(layer.radius, 0.12, 8, 96),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.copy(disc.position);
      standingGroup.add(rim);

      const tag = document.createElement("div");
      tag.className = "graph-layer-tag";
      tag.textContent = `${layer.key} · ${layer.count}`;
      const anchor = new CSS2DObject(tag);
      anchor.position.set(-layer.radius - 3, layer.y, 0);
      standingGroup.add(anchor);
    }

    // 节点：球，半径 = 爆炸半径说话。
    for (const [index, node] of model.nodes.entries()) {
      const color = LAYER_COLORS[node.layer % LAYER_COLORS.length];
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(nodeRadius(node), 20, 14),
        new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
      );
      mesh.position.set(node.x, node.y, node.z);
      mesh.userData.index = index;
      scene.add(mesh);
      meshes.push(mesh);

      const text = document.createElement("div");
      text.className = "graph-node-label";
      text.textContent = node.name;
      const label = new CSS2DObject(text);
      label.position.set(0, nodeRadius(node) + 1.1, 0);
      label.userData.always = node.blast >= 12;   // 远景档只留大件的名字
      mesh.add(label);
      labels.push(label);
    }

    // 常亮的两种「不对劲」：向上的边（违规）、断头的边（图外缺口）。
    for (const edge of model.edges) {
      if (!edge.upward) continue;
      standingGroup.add(
        line(centerOf(edge.from), centerOf(edge.to), VIOLATION_COLOR, 0.5));
    }
    for (const gap of model.dangling) {
      const from = centerOf(gap.from);
      const out = from.clone().add(new THREE.Vector3(0, 4.5, 0));
      standingGroup.add(line(from, out, VIOLATION_COLOR, 0.8, true));
    }

    fitCamera();
    select(null);
  }

  function fitCamera() {
    if (!model || model.layers.length === 0) return;
    const top = model.layers[model.layers.length - 1].y;
    const radius = Math.max(...model.layers.map((layer) => layer.radius));
    controls.target.set(0, top / 2, 0);
    camera.position.set(radius * 1.8, top / 2 + radius * 1.2, top / 2 + radius * 2.2);
    controls.update();
  }

  /** 选中：亮边。绿 = 它依赖谁，橙 = 谁依赖它，微光 = 爆炸半径波及的。 */
  function select(index) {
    selected = index;
    clearGroup(edgeGroup);
    if (nearCard) { nearCard.parent?.remove(nearCard); nearCard = null; }

    const dependencies = new Set();
    const dependents = new Set();
    if (index !== null && model) {
      for (const edge of model.edges) {
        if (edge.from === index) dependencies.add(edge.to);
        if (edge.to === index) dependents.add(edge.from);
      }
      const blast = new Set([index]);
      const queue = [index];
      while (queue.length > 0) {
        const current = queue.shift();
        for (const edge of model.edges) {
          if (edge.to === current && !blast.has(edge.from)) {
            blast.add(edge.from); queue.push(edge.from);
          }
        }
      }
      for (const to of dependencies) {
        edgeGroup.add(line(centerOf(index), centerOf(to), DEP_COLOR, 0.85));
      }
      for (const from of dependents) {
        edgeGroup.add(line(centerOf(from), centerOf(index), DEPENDENT_COLOR, 0.8));
      }
      for (const [other, mesh] of meshes.entries()) {
        const inBlast = blast.has(other);
        mesh.material.opacity = other === index || dependencies.has(other)
          || dependents.has(other) ? 1 : inBlast ? 0.75 : 0.28;
        mesh.material.transparent = true;
      }
    } else {
      for (const mesh of meshes) { mesh.material.opacity = 1; mesh.material.transparent = false; }
    }

    for (const [other, mesh] of meshes.entries()) {
      const node = model?.nodes[other];
      const base = LAYER_COLORS[(node?.layer ?? 0) % LAYER_COLORS.length];
      mesh.material.color.setHex(
        other === index ? SELECT_COLOR
          : dependencies.has(other) ? DEP_COLOR
            : dependents.has(other) ? DEPENDENT_COLOR : base);
    }
    callbacks.onSelect?.(index);
  }

  /** 飞到一个节点跟前 —— 「飞进去」的另一半。reduced-motion 下瞬移。 */
  function flyTo(index) {
    const target = centerOf(index);
    const offset = new THREE.Vector3(10, 6, 10);
    const destination = target.clone().add(offset);
    if (still) {
      controls.target.copy(target);
      camera.position.copy(destination);
      controls.update();
      return;
    }
    flight = {
      fromTarget: controls.target.clone(), toTarget: target,
      fromCamera: camera.position.clone(), toCamera: destination,
      start: performance.now(), ms: 700,
    };
  }

  /** 近景档：把选中节点的配料单牌挂到它旁边。内容是调用方给的 DOM。 */
  function showNearCard(index, element) {
    if (selected !== index) return;
    if (nearCard) nearCard.parent?.remove(nearCard);
    nearCard = new CSS2DObject(element);
    nearCard.position.set(0, nodeRadius(model.nodes[index]) + 2.2, 0);
    nearCard.visible = false;
    meshes[index].add(nearCard);
  }

  function pick(event) {
    const box = labelRenderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
    pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
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
      label.visible = label.userData.always || layerNear.get(node.layer) === true
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
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
