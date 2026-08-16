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
  folder: 0xd9b28e,
  added: 0x9fae8e,
  modified: 0xd9b28e,
  unchanged: 0x8e8995,
  deleted: 0xa97879,
  replaced: 0xc4a2b8,
  dependency: 0x8fbf9d,
  dependent: 0xdf9d66,
};

const asPosition = (node) => new THREE.Vector3(node.x, node.y, node.z);

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
    : kind === "input" ? `${node.phase} 输入` : node.name;
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
  let model = null;
  let selected = null;
  let frame = 0;
  let stopped = false;

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

  function put(id, node, kind, mesh) {
    const group = new THREE.Group();
    group.position.copy(asPosition(node));
    mesh.userData.id = id;
    mesh.userData.path = kind === "file" ? node.path : null;
    group.add(mesh, labelFor(node, kind));
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

  function addFolder(node) {
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.22 + Math.min(node.count, 12) * .035, 1),
      nodeMaterial(TINT.folder, .82),
    );
    shell.scale.y = .6;
    put(node.id, node, "folder", shell);
  }

  function addFile(node) {
    const size = node.display === "deleted" ? .54 : .68;
    const geometry = node.display === "replaced"
      ? new THREE.OctahedronGeometry(size, 0)
      : new THREE.IcosahedronGeometry(size, 0);
    const core = new THREE.Mesh(geometry, nodeMaterial(TINT[node.display]));
    if (node.display === "deleted") core.rotation.z = Math.PI / 4;
    put(node.id, node, "file", core);
  }

  function setModel(next) {
    disposeTree(stable);
    disposeTree(dependencyLines);
    objects.clear(); paths.clear(); hits.length = 0;
    selected = null;
    model = next;
    for (const node of next?.inputs ?? []) addInput(node);
    for (const node of next?.folders ?? []) addFolder(node);
    for (const node of next?.files ?? []) addFile(node);
    for (const edge of next?.production ?? []) {
      const from = objects.get(edge.from);
      const to = objects.get(edge.to);
      if (from && to) stable.add(lineBetween(from.position, to.position, TINT.folder, .12));
    }
  }

  function select(path, dependencies = null) {
    selected = path;
    disposeTree(dependencyLines);
    for (const [candidate, group] of paths) {
      group.scale.setScalar(candidate === path ? 1.55 : 1);
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
    if (hit?.userData.path) callbacks.onSelect(hit.userData.path);
  };
  renderer.domElement.addEventListener("pointerup", onPointer);

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
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
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      model = null; selected = null;
    },
  };
}
