/**
 * Stage 产物驾驶舱的空间层。
 *
 * 服务端已经给出确定坐标；这里不重算目录或依赖。常态只画生产谱系，代码依赖只有
 * `select(path, dependencies)` 后才亮。WebGL 起不来时返回同一接口的平面目录图。
 */
import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const TINT = {
  input: 0xc4a2b8,
  round: 0xf0c987,
  folder: 0xd9b28e,
  added: 0x9fae8e,
  modified: 0xd9b28e,
  unchanged: 0x8e8995,
  deleted: 0xa97879,
  replaced: 0xc4a2b8,
  dependency: 0x8fbf9d,
  dependent: 0xdf9d66,
};

/** 角色决定形状：文档是片、代码是晶体、结构化证据是多面体、反方是环。 */
const ROLE_GEOMETRY = {
  producer: (size) => new THREE.CylinderGeometry(size, size, size * .22, 6),
  critic: (size) => new THREE.TorusGeometry(size * .78, size * .26, 8, 18),
  delivery: (size) => new THREE.IcosahedronGeometry(size, 0),
  structured: (size) => new THREE.OctahedronGeometry(size * 1.05, 0),
};

/** 看这张图的固定仰角：够高能看清目录分区，够低还认得出这是一个平面。 */
const ELEVATION = Math.PI * .3;

const asPosition = (node) => new THREE.Vector3(node.x, node.y, node.z);

function glowTexture() {
  const surface = document.createElement("canvas");
  surface.width = 64;
  surface.height = 64;
  const brush = surface.getContext("2d");
  const fade = brush.createRadialGradient(32, 32, 0, 32, 32, 32);
  fade.addColorStop(0, "rgba(255,255,255,.95)");
  fade.addColorStop(.22, "rgba(255,255,255,.52)");
  fade.addColorStop(.58, "rgba(255,255,255,.11)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  brush.fillStyle = fade;
  brush.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(surface);
}

function fallbackScene(container, callbacks) {
  const root = document.createElement("div");
  root.className = "stage-artifact-fallback";
  container.append(root);
  let rows = new Map();
  let model = null;

  const setModel = (next) => {
    model = next;
    rows = new Map();
    root.replaceChildren();

    const inputs = document.createElement("div");
    inputs.className = "stage-fallback-inputs";
    for (const node of next?.inputs ?? []) {
      const item = document.createElement("span");
      item.className = "stage-fallback-input";
      item.textContent = `输入 · ${node.phase}`;
      inputs.append(item);
    }
    root.append(inputs);

    const folders = document.createElement("div");
    folders.className = "stage-fallback-folders";
    for (const node of next?.folders ?? []) {
      const item = document.createElement("span");
      item.className = "stage-fallback-folder";
      item.textContent = `${node.path}/ · ${node.count}`;
      folders.append(item);
    }
    root.append(folders);

    const files = document.createElement("div");
    files.className = "stage-fallback-files";
    for (const node of next?.files ?? []) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "stage-fallback-file";
      item.textContent = node.path;
      item.dataset.path = node.path;
      item.setAttribute("aria-selected", "false");
      item.addEventListener("click", () => callbacks.onSelect(node.path));
      rows.set(node.path, item);
      files.append(item);
    }
    root.append(files);
  };

  return {
    fallback: true,
    setModel,
    select(path) {
      for (const [candidate, row] of rows) {
        row.setAttribute("aria-selected", String(candidate === path));
      }
    },
    filter(paths) {
      const visible = paths === null ? null : new Set(paths);
      for (const [path, row] of rows) row.hidden = visible !== null && !visible.has(path);
    },
    dispose() { root.remove(); rows.clear(); model = null; },
  };
}

function labelFor(node, kind) {
  const text = document.createElement("span");
  text.className = "stage-artifact-node-label";
  text.dataset.kind = kind;
  text.textContent = kind === "folder" ? `${node.path}/ · ${node.count}`
    : kind === "input" ? `${node.phase} 输入`
      : kind === "round" ? `第 ${node.round} 轮` : node.name;
  const label = new CSS2DObject(text);
  label.position.y = kind === "file" ? 1.45 : 1.8;
  return label;
}

function lineBetween(from, to, color, opacity) {
  const middle = from.clone().add(to).multiplyScalar(.5);
  middle.y += Math.max(1.2, from.distanceTo(to) * .08);
  const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(20)),
    new THREE.LineBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function disposeTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
    else object.material?.dispose();
    if (object.isCSS2DObject) object.element.remove();
  });
  root.clear();
}

export function createStageArtifactScene(container, callbacks) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return fallbackScene(container, callbacks);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = "stage-artifact-scene-labels";
  container.append(labels.domElement);

  const world = new THREE.Scene();
  world.fog = new THREE.FogExp2(0x151220, .011);
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 500);
  camera.position.set(7, 45, 59);
  camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  controls.minDistance = 24;
  controls.maxDistance = 110;
  controls.maxPolarAngle = Math.PI * .73;
  controls.target.set(0, 0, 0);

  world.add(new THREE.HemisphereLight(0xffecd3, 0x211a2d, 1.35));
  const key = new THREE.DirectionalLight(0xffddb4, 1.7);
  key.position.set(-20, 42, 26);
  world.add(key);

  const stable = new THREE.Group();
  const dependencyLines = new THREE.Group();
  world.add(stable, dependencyLines);
  const objects = new Map();
  const paths = new Map();
  const hits = [];
  const folderHits = [];
  const expanded = new Set();
  let framedSignature = null;
  let builtSignature = null;
  let model = null;
  let selected = null;
  let frame = 0;
  let stopped = false;
  const glow = glowTexture();

  function nodeMaterial(color, opacity = 1) {
    return new THREE.MeshStandardMaterial({
      color: 0xefe5d5,
      emissive: color,
      emissiveIntensity: .28,
      metalness: .12,
      roughness: .52,
      transparent: opacity < 1,
      opacity,
    });
  }

  function put(id, node, kind, mesh, showLabel = true) {
    const group = new THREE.Group();
    group.position.copy(asPosition(node));
    mesh.userData.id = id;
    mesh.userData.path = kind === "file" ? node.path : null;
    const label = labelFor(node, kind);
    label.visible = showLabel;
    group.userData = { label, showLabel };
    const tint = kind === "input" ? TINT.input
      : kind === "folder" ? TINT.folder : TINT[node.display];
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow,
      color: tint,
      transparent: true,
      opacity: kind === "folder" ? .58 : .42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    halo.scale.setScalar(kind === "folder" ? 6.5 : kind === "input" ? 4.6 : 3.4);
    group.add(halo, mesh, label);
    stable.add(group);
    objects.set(id, group);
    if (kind === "file") {
      paths.set(node.path, group);
      hits.push(mesh);
    }
  }

  function addInput(node) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, .08, 10, 42),
      new THREE.MeshBasicMaterial({
        color: TINT.input, transparent: true, opacity: .52,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    put(node.id, node, "input", ring);
  }

  function addRound(node) {
    const core = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, .16, 12, 48),
      new THREE.MeshBasicMaterial({
        color: TINT.round, transparent: true, opacity: .78,
        blending: THREE.AdditiveBlending,
      }),
    );
    core.rotation.x = Math.PI / 2;
    put(node.id, node, "round", core);
  }

  /** 目录画成一块能认出来的地，不是又一颗球。 */
  function addFolder(node) {
    const group = new THREE.Group();
    group.position.copy(asPosition(node));
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(node.radius, 56),
      new THREE.MeshBasicMaterial({
        color: TINT.folder, transparent: true, opacity: .055,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -.35;
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(node.radius - .07, node.radius, 72),
      new THREE.MeshBasicMaterial({
        color: TINT.folder, transparent: true, opacity: .3,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = -.34;
    // 整块地都是点击目标。只让 0.07 宽的描边可点，等于没有。
    disc.userData.id = node.id;
    disc.userData.folder = node.path;
    const label = labelFor(node, "folder");
    label.position.y = 0;
    label.position.z = node.radius + .9;
    group.add(disc, rim, label);
    group.userData = { label, showLabel: true };
    stable.add(group);
    objects.set(node.id, group);
    folderHits.push(disc);
  }

  function addFile(node, showLabel) {
    const size = node.display === "deleted" ? .5 : .66;
    const build = ROLE_GEOMETRY[node.role] ?? ROLE_GEOMETRY.delivery;
    const core = new THREE.Mesh(build(size), nodeMaterial(TINT[node.display]));
    if (node.display === "deleted") core.rotation.z = Math.PI / 4;
    if (node.display === "replaced") core.rotation.y = Math.PI / 4;
    put(node.id, node, "file", core, showLabel);
  }

  /** 这一份投影的全部可见事实。一样就没必要重建。 */
  function signatureOf(next) {
    if (!next) return "";
    return JSON.stringify([
      next.round,
      next.source,
      next.hub?.round ?? null,
      next.inputs?.map((node) => node.id),
      next.folders?.map((node) => [node.id, node.count, node.radius]),
      next.files?.map((node) => [node.id, node.display, node.role]),
      [...expanded].sort(),
    ]);
  }

  function setModel(next) {
    // 5 秒一次的轮询绝大多数时候什么都没变。照旧全拆全建会把几何体、材质和
    // 标签元素每 5 秒扔掉重做一遍 —— 屏幕上是标签闪一下，机器上是白烧。
    const signature = signatureOf(next);
    if (signature === builtSignature) {
      model = next;
      return;
    }
    builtSignature = signature;
    disposeTree(stable);
    disposeTree(dependencyLines);
    objects.clear(); paths.clear(); hits.length = 0; folderHits.length = 0;
    selected = null;
    model = next;
    const collapsed = new Set(
      (next?.folders ?? [])
        .filter((folder) => folder.aggregated && !expanded.has(folder.path))
        .map((folder) => folder.path),
    );
    if (next?.hub) addRound(next.hub);
    for (const node of next?.inputs ?? []) addInput(node);
    for (const node of next?.folders ?? []) addFolder(node);
    for (const node of next?.files ?? []) addFile(node, !collapsed.has(node.folder));
    for (const edge of next?.production ?? []) {
      const from = objects.get(edge.from);
      const to = objects.get(edge.to);
      if (!from || !to) continue;
      stable.add(lineBetween(
        from.position, to.position,
        edge.kind === "folder-file" ? TINT.folder : TINT.round,
        edge.kind === "folder-file" ? .13 : .3,
      ));
    }
    // 只有图的形状变了才重新取景。5 秒一次的轮询不能把人正在看的角度抢走。
    const shape = `${next?.round ?? ""}|${(next?.files ?? []).map((file) => file.id).join(",")}`;
    if (shape !== framedSignature) {
      framedSignature = shape;
      frameContent(next);
    }
  }

  /** 把相机推到刚好装下整张图的地方 —— 内容不该缩在角落里。 */
  function frameContent(next) {
    const points = [
      ...(next?.hub ? [next.hub] : []),
      ...(next?.inputs ?? []),
      ...(next?.files ?? []),
    ];
    const bounds = new THREE.Box3();
    if (points.length === 0) bounds.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(20, 1, 20));
    else for (const point of points) bounds.expandByPoint(asPosition(point));
    for (const folder of next?.folders ?? []) {
      bounds.expandByPoint(new THREE.Vector3(folder.x - folder.radius, 0, folder.z - folder.radius));
      bounds.expandByPoint(new THREE.Vector3(folder.x + folder.radius, 0, folder.z + folder.radius));
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const aspect = Math.max(.35, camera.aspect);
    // 相机的仰角固定在 ELEVATION，地面在竖直方向上被压缩成 sin(仰角)。
    // 不把这一下算进去，取景就会以为自己需要退得比实际远得多。
    const vertical = Math.max(size.z * Math.sin(ELEVATION), size.x / aspect, 12);
    const distance = (vertical / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.1;
    controls.minDistance = Math.max(8, distance * .25);
    controls.maxDistance = distance * 3.2;
    controls.target.copy(center);
    camera.position.set(
      center.x,
      center.y + distance * Math.sin(ELEVATION),
      center.z + distance * Math.cos(ELEVATION),
    );
    camera.updateProjectionMatrix();
    controls.update();
  }

  function select(path, dependencies = null) {
    selected = path;
    disposeTree(dependencyLines);
    for (const [candidate, group] of paths) {
      group.scale.setScalar(candidate === path ? 1.55 : 1);
      group.userData.label.visible = group.userData.showLabel || candidate === path;
      const mesh = group.children.find((child) => child.isMesh);
      if (mesh?.material) mesh.material.emissiveIntensity = candidate === path ? .95 : .28;
    }
    if (dependencies === null) return;
    for (const edge of dependencies.edges ?? []) {
      const from = paths.get(edge.from);
      const to = paths.get(edge.to);
      if (!from || !to) continue;
      dependencyLines.add(lineBetween(
        from.position, to.position,
        edge.direction === "dependency" ? TINT.dependency : TINT.dependent,
        .86,
      ));
    }
  }

  function filter(visiblePaths) {
    const visible = visiblePaths === null ? null : new Set(visiblePaths);
    for (const [path, group] of paths) {
      const on = visible === null || visible.has(path);
      group.visible = on;
    }
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const onPointer = (event) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hits, false)[0]?.object;
    if (hit?.userData.path) {
      callbacks.onSelect(hit.userData.path);
      return;
    }
    // 点密目录 = 把它摊开。设计里说的“放大或点目录才展开”。
    const folder = raycaster.intersectObjects(folderHits, false)[0]?.object;
    const path = folder?.userData.folder;
    if (path === undefined) return;
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    const keep = selected;
    setModel(model);
    if (keep !== null) select(keep);
  };
  renderer.domElement.addEventListener("pointerup", onPointer);

  let sizedWidth = 0;
  let sizedHeight = 0;
  /**
   * ResizeObserver 会在布局只走了一半的时候回调 —— 实测把窗口从 1440 收到 1280，
   * 它报的高度已经是新的、宽度还是旧的，然后就不再回调了，canvas 从此比容器宽。
   * 所以每帧对一次尺寸，不一致才真的改；一致时只是两次属性读取。
   */
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    if (width === sizedWidth && height === sizedHeight) return;
    sizedWidth = width;
    sizedHeight = height;
    // updateStyle = false：canvas 的 CSS 尺寸由样式表的 100% 说了算，这里只调
    // drawing buffer 的分辨率。三个地方各管各的，谁都不会写歪几何。
    renderer.setSize(width, height, false);
    labels.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const paint = () => {
    if (stopped) return;
    frame = requestAnimationFrame(paint);
    resize();
    controls.update();
    renderer.render(world, camera);
    labels.render(world, camera);
  };
  paint();

  return {
    fallback: false,
    setModel,
    select,
    filter,
    dispose() {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerup", onPointer);
      controls.dispose();
      disposeTree(stable);
      disposeTree(dependencyLines);
      glow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      model = null; selected = null;
    },
  };
}
